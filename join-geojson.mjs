import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as turf from '@turf/turf';
import compression from 'compression';

const app = express();
const port = 8003;

app.use(compression());
app.use(express.json());

// ---------- modes ----------
const MODE = { NO_HOLES: 'no-holes', SHELL: 'shell' };
const SHELL = { CONCAVE: 'concave', CONVEX: 'convex' };

// ---------- io utils ----------
const readGeoJSON = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

/** loads per-zip files with progress logs (used by /process-zipcodes) */
const loadGeoJSONFiles = async (directory, zipcodes) => {
    console.log(`\n=== Loading ${zipcodes.length} ZIPs from: ${path.resolve(directory)} ===`);
    console.time('load:all_zips');
    let found = 0, missing = 0;

    const reads = zipcodes.map(async (zipcode, idx) => {
        const filePath = path.join(directory, `${zipcode}.geojson`);
        process.stdout.write(`  [${idx + 1}/${zipcodes.length}] ${zipcode} → `);
        try {
            await fs.access(filePath);
            found++;
            console.log('✅ found');
            return readGeoJSON(filePath);
        } catch {
            missing++;
            console.log('❌ missing');
            return null;
        }
    });

    const results = await Promise.all(reads);
    console.timeEnd('load:all_zips');
    console.log(`Summary: found=${found}, missing=${missing}\n`);
    return results;
};

// ---------- geo helpers ----------
const mergeGeoJSONFeatures = (geojsons) => {
    const all = geojsons.filter(Boolean).flatMap((g) => Array.isArray(g.features) ? g.features : []);
    console.log(`merge: collected ${all.length} features`);
    return turf.featureCollection(all);
};

const cleanPolyFeature = (feat) => {
    try {
        const buffered = turf.buffer(feat, 0.0001, { units: 'kilometers' });
        const unk = turf.unkinkPolygon(buffered);
        if (unk?.features?.length) return turf.combine(unk).features[0] ?? feat;
        return buffered ?? feat;
    } catch { return feat; }
};

const dissolveFeatures = (fc) => {
    const polys = fc.features.filter(
        (f) => f?.geometry && ['Polygon', 'MultiPolygon'].includes(f.geometry.type)
    );
    console.log(`dissolve: input polys=${polys.length}`);
    if (!polys.length) return null;

    console.time('dissolve:clean');
    const cleaned = polys.map(cleanPolyFeature);
    console.timeEnd('dissolve:clean');

    let acc = cleaned[0];
    console.time('dissolve:union');
    for (let i = 1; i < cleaned.length; i++) {
        const cur = cleaned[i];
        if (!cur) continue;
        if (i % 25 === 0) console.log(`  union progress: ${i}/${cleaned.length}`);
        try {
            const u = turf.union(acc, cur);
            if (u) acc = u;
        } catch {
            try {
                const a2 = turf.buffer(acc, 0.00005, { units: 'kilometers' });
                const c2 = turf.buffer(cur, 0.00005, { units: 'kilometers' });
                const u2 = turf.union(a2, c2);
                if (u2) acc = u2;
            } catch {}
        }
    }
    console.timeEnd('dissolve:union');
    return acc;
};

const getOuterBoundary = (fc) => (fc?.features?.length ? dissolveFeatures(fc) : null);

// remove interior holes only
function removeHoles(feature) {
    if (!feature?.geometry) return feature;
    const { type, coordinates } = feature.geometry;
    if (type === 'Polygon') return turf.polygon([coordinates[0]], feature.properties);
    if (type === 'MultiPolygon') {
        return turf.multiPolygon(coordinates.map((poly) => [poly[0]]), feature.properties);
    }
    return feature;
}

// concave/convex shell
function buildOuterShell(input, { maxEdgeKm = 10, shellType = SHELL.CONCAVE } = {}) {
    const fc = input?.type === 'FeatureCollection' ? input : turf.featureCollection([input]);
    const coords = turf.coordAll(fc);
    const points = turf.featureCollection(coords.map((c) => turf.point(c)));

    console.log(`shell: points=${points.features.length}, type=${shellType}, maxEdgeKm=${maxEdgeKm}`);

    if (shellType === SHELL.CONVEX) {
        const out = turf.convex(points) || turf.bboxPolygon(turf.bbox(points));
        return out;
    }

    let shell = null;
    if (points.features.length >= 4) {
        try { shell = turf.concave(points, { maxEdge: maxEdgeKm }); } catch {}
    }
    if (!shell) shell = turf.convex(points) || turf.bboxPolygon(turf.bbox(points));
    return shell;
}

// optional simplify
function maybeSimplify(input, tolerance = 0) {
    if (!tolerance) return input;
    console.log(`simplify: tolerance=${tolerance}`);
    try { return turf.simplify(input, { tolerance, highQuality: false, mutate: false }); }
    catch { return input; }
}

// explode MultiPolygon → individual Polygons
function explodePolygons(fc) {
    const out = [];
    for (const f of fc.features || []) {
        if (!f?.geometry) continue;
        const { type, coordinates } = f.geometry;
        if (type === 'Polygon') out.push(turf.polygon(coordinates, f.properties));
        else if (type === 'MultiPolygon') {
            for (const poly of coordinates) out.push(turf.polygon(poly, f.properties));
        }
    }
    return out;
}

// concave hull from one centroid per polygon (very stable)
function buildCentroidHull(input, { maxEdgeKm = 20, simplifyTolerance = 0.0005 } = {}) {
    const fc = input?.type === 'FeatureCollection' ? input : turf.featureCollection([input]);
    const polys = explodePolygons(fc);
    if (!polys.length) return null;

    const pts = turf.featureCollection(
        polys.map(p => { try { return turf.centerOfMass(p); } catch { return null; } }).filter(Boolean)
    );

    let hull = null;
    if (pts.features.length >= 3) {
        try { hull = turf.concave(pts, { maxEdge: maxEdgeKm }); } catch {}
    }
    if (!hull) hull = turf.convex(pts);
    if (!hull) return null;

    hull = maybeSimplify(hull, simplifyTolerance);

    if (hull?.geometry?.type === 'Polygon') {
        hull.geometry.coordinates = hull.geometry.coordinates.map(ring => {
            const a = ring[0], b = ring[ring.length - 1];
            return (a[0] !== b[0] || a[1] !== b[1]) ? [...ring, a] : ring;
        });
    }
    return hull;
}

// morphology with guardrails
function buildMorphologicalShellSafe(input, {
    joinKm = 3,
    simplifyTolerance = 0.001,
    erosionFactor = 0.5,
    minAreaRetain = 0.6,
    finalConcaveKm = 0
} = {}) {
    const fc = input?.type === 'FeatureCollection' ? input : turf.featureCollection([input]);
    if (!fc?.features?.length) return null;

    // buffer OUT
    const buffered = fc.features
        .filter(f => f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
        .map(f => { try { return turf.buffer(f, joinKm, { units: 'kilometers' }); } catch { return null; } })
        .filter(Boolean);
    if (!buffered.length) return null;

    // dissolve
    let acc = buffered[0];
    for (let i = 1; i < buffered.length; i++) {
        try { const u = turf.union(acc, buffered[i]); if (u) acc = u; } catch {}
    }
    if (!acc) return null;

    const areaDilated = turf.area(acc);

    // gentle erosion (or skip)
    const peelKm = Math.max(0, joinKm * erosionFactor);
    let peeled = acc;
    if (peelKm > 0) {
        try {
            const candidate = turf.buffer(acc, -peelKm, { units: 'kilometers' });
            if (candidate?.geometry) {
                const areaCand = turf.area(candidate);
                if (areaCand > areaDilated * minAreaRetain &&
                    (candidate.geometry.type === 'Polygon' || candidate.geometry.type === 'MultiPolygon')) {
                    peeled = candidate;
                } // else keep acc (avoid spaghetti)
            }
        } catch {}
    }

    let outer = removeHoles(peeled);
    outer = maybeSimplify(outer, simplifyTolerance);

    if (finalConcaveKm && finalConcaveKm > 0) {
        const pts = turf.featureCollection(turf.coordAll(outer).map(c => turf.point(c)));
        try {
            const hull = turf.concave(pts, { maxEdge: finalConcaveKm });
            if (hull) outer = hull;
        } catch {}
    }

    if (outer?.geometry?.type === 'Polygon') {
        outer.geometry.coordinates = outer.geometry.coordinates.map(ring => {
            const a = ring[0], b = ring[ring.length - 1];
            return (a[0] !== b[0] || a[1] !== b[1]) ? [...ring, a] : ring;
        });
    }
    return outer;
}

// ---------- logging ----------
const logMissingZipCodes = async (directory, zipcodes) => {
    if (!directory || !Array.isArray(zipcodes) || !zipcodes.length) return;
    const missing = [];
    for (const z of zipcodes) {
        const filePath = path.join(directory, `${z}.geojson`);
        try { await fs.access(filePath); } catch { missing.push(z); }
    }
    if (!missing.length) { console.log('missing-zip: all present'); return; }

    const missingFilePath = path.join('./', 'missing-zip.txt');
    try {
        let existing = [];
        try {
            const existingData = await fs.readFile(missingFilePath, 'utf8');
            existing = existingData.split('\n').filter(Boolean);
        } catch (readErr) { if (readErr.code !== 'ENOENT') throw readErr; }
        const all = new Set([...existing, ...missing]);
        await fs.writeFile(missingFilePath, [...all].join('\n'), 'utf8');
        console.log(`missing-zip: appended ${missing.length} entries → ${missingFilePath}`);
    } catch (err) {
        console.error('missing-zip: error writing file:', err);
    }
};

// ---------- endpoints ----------

/**
 * POST /process-zipcodes
 * Body:
 * { "zipcodes": ["51242","99522"], "mode": "shell"|"no-holes", "shellType": "concave"|"convex",
 *   "maxEdgeKm": 10, "simplifyTolerance": 0.001 }
 */
app.post('/process-zipcodes', async (req, res) => {
    const {
        zipcodes,
        mode = MODE.NO_HOLES,
        shellType = SHELL.CONCAVE,
        maxEdgeKm = 10,
        simplifyTolerance = 0
    } = req.body;

    if (!Array.isArray(zipcodes) || !zipcodes.length) {
        return res.status(400).json({ error: 'Invalid input. Expected a non-empty array of zip codes.' });
    }

    console.log(`\n=== /process-zipcodes request (${zipcodes.length} zips) ===`);
    console.log(`mode=${mode}, shellType=${shellType}, maxEdgeKm=${maxEdgeKm}, simplifyTolerance=${simplifyTolerance}`);
    console.log(`zips: ${zipcodes.join(', ')}`);

    const geojsonDirectory = './geojson-files';

    try {
        const geojsons = await loadGeoJSONFiles(geojsonDirectory, zipcodes);

        console.time('pipeline:merge');
        const merged = mergeGeoJSONFeatures(geojsons);
        console.timeEnd('pipeline:merge');

        if (!merged.features.length) {
            await logMissingZipCodes(geojsonDirectory, zipcodes);
            console.log('pipeline: no features loaded, returning empty FC');
            return res.json(turf.featureCollection([]));
        }

        console.time('pipeline:dissolve');
        const dissolved = getOuterBoundary(merged) || merged;
        console.timeEnd('pipeline:dissolve');

        const prepped = maybeSimplify(dissolved, simplifyTolerance);

        let output = null;
        if (mode === MODE.SHELL) {
            console.time('pipeline:shell');
            output = buildOuterShell(prepped, { maxEdgeKm, shellType });
            console.timeEnd('pipeline:shell');
        } else {
            console.time('pipeline:removeHoles');
            output = removeHoles(prepped);
            console.timeEnd('pipeline:removeHoles');
        }

        console.log('pipeline: done ✅');
        return res.json(output || turf.featureCollection([]));
    } catch (error) {
        console.error('pipeline: error ❌', error);
        return res.status(500).json({ error: 'Internal server error' });
    } finally {
        try { await logMissingZipCodes(geojsonDirectory, zipcodes); } catch {}
    }
});

/**
 * POST /outer-shell-from-zip
 * Build ONE outer boundary from a single ZIP's GeoJSON on disk.
 * Body:
 * {
 *   "zip": "51242",
 *   "directory": "./geojson-files",
 *   "mode": "morpho-safe" | "centroid-hull" | "shell" | "no-holes",   // default: "morpho-safe"
 *   // morpho-safe:
 *   "joinKm": 3, "simplifyTolerance": 0.001, "erosionFactor": 0.5, "minAreaRetain": 0.6, "finalConcaveKm": 0,
 *   // centroid-hull:
 *   "maxEdgeKm": 20,
 *   // shell:
 *   "shellType": "concave", "maxEdgeKm": 25
 * }
 */
app.post('/outer-shell-from-zip', async (req, res) => {
    const {
        zip,
        directory = './geojson-files',
        mode = 'morpho-safe',

        // morpho-safe params
        joinKm = 3,
        simplifyTolerance = 0.001,
        erosionFactor = 0.5,
        minAreaRetain = 0.6,
        finalConcaveKm = 0,

        // centroid-hull + shell params
        maxEdgeKm = 20,
        shellType = SHELL.CONCAVE
    } = req.body;

    if (!zip) return res.status(400).json({ error: 'Missing `zip`.' });

    try {
        const filePath = path.join(directory, `${zip}.geojson`);
        let input;
        try {
            await fs.access(filePath);
            input = await readGeoJSON(filePath);
        } catch {
            await logMissingZipCodes(directory, [zip]).catch(() => {});
            return res.status(404).json({ error: `GeoJSON not found for ZIP ${zip}` });
        }

        const fc = input.type === 'FeatureCollection' ? input : turf.featureCollection([input]);
        if (!fc.features?.length) return res.json(turf.featureCollection([]));

        console.log('\n=== /outer-shell-from-zip ===');
        console.log(`zip=${zip}, features=${fc.features.length}, mode=${mode}`);

        let out = null;

        if (mode === 'morpho-safe') {
            out = buildMorphologicalShellSafe(fc, {
                joinKm, simplifyTolerance, erosionFactor, minAreaRetain, finalConcaveKm
            });
            if (!out) {
                console.log('morpho-safe failed → fallback to centroid-hull');
                out = buildCentroidHull(fc, { maxEdgeKm, simplifyTolerance });
            }
        } else if (mode === 'centroid-hull') {
            out = buildCentroidHull(fc, { maxEdgeKm, simplifyTolerance });
        } else if (mode === MODE.NO_HOLES) {
            const polys = explodePolygons(fc);
            let acc = polys[0];
            for (let i = 1; i < polys.length; i++) {
                try { const u = turf.union(acc, polys[i]); if (u) acc = u; } catch {}
            }
            const prepped = maybeSimplify(turf.featureCollection([acc]), simplifyTolerance);
            out = removeHoles(prepped);
        } else {
            // classic concave/convex shell on all coordinates
            const coords = turf.coordAll(fc);
            const points = turf.featureCollection(coords.map(c => turf.point(c)));
            out = buildOuterShell(points, { maxEdgeKm, shellType });
        }

        if (!out) return res.json(turf.featureCollection([]));

        if (out?.geometry?.type === 'Polygon') {
            out.geometry.coordinates = out.geometry.coordinates.map(ring => {
                const first = ring[0], last = ring[ring.length - 1];
                return (first[0] !== last[0] || first[1] !== last[1]) ? [...ring, first] : ring;
            });
        }

        console.log('single: done ✅');
        return res.json(out);
    } catch (err) {
        console.error('single: error ❌', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ---------- start ----------
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
