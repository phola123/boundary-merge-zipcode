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

/**
 * Loads per-zip files with progress logs.
 */
const loadGeoJSONFiles = async (directory, zipcodes) => {
    console.log(`\n=== Loading ${zipcodes.length} ZIPs from: ${path.resolve(directory)} ===`);
    console.time('load:all_zips');

    let found = 0, missing = 0;

    const reads = zipcodes.map(async (zipcode, idx) => {
        const filePath = path.join(directory, `${zipcode}.geojson`);
        process.stdout.write(
            `  [${idx + 1}/${zipcodes.length}] ${zipcode} → `
        );
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

// ---------- geo utils ----------
const mergeGeoJSONFeatures = (geojsons) => {
    const allFeatures = geojsons
        .filter(Boolean)
        .flatMap((g) => Array.isArray(g.features) ? g.features : []);
    console.log(`merge: collected ${allFeatures.length} features`);
    return turf.featureCollection(allFeatures);
};

// Clean polygon-ish feature to reduce topology issues
const cleanPolyFeature = (feat) => {
    try {
        const buffered = turf.buffer(feat, 0.0001, { units: 'kilometers' });
        const unk = turf.unkinkPolygon(buffered);
        if (unk?.features?.length) {
            return turf.combine(unk).features[0] ?? feat;
        }
        return buffered ?? feat;
    } catch {
        return feat;
    }
};

// Dissolve polygons safely (Polygon/MultiPolygon only) with progress logs
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
            // Fallback: buffer both slightly and retry
            try {
                const a2 = turf.buffer(acc, 0.00005, { units: 'kilometers' });
                const c2 = turf.buffer(cur, 0.00005, { units: 'kilometers' });
                const u2 = turf.union(a2, c2);
                if (u2) acc = u2;
            } catch {
                // keep current accumulator and move on
            }
        }
    }
    console.timeEnd('dissolve:union');
    return acc;
};

const getOuterBoundary = (featureCollection) => {
    if (!featureCollection?.features?.length) return null;
    return dissolveFeatures(featureCollection);
};

// --------- Option A: keep outline, strip interior holes ----------
function removeHoles(feature) {
    if (!feature?.geometry) return feature;
    const { type, coordinates } = feature.geometry;

    if (type === 'Polygon') {
        return turf.polygon([coordinates[0]], feature.properties);
    }
    if (type === 'MultiPolygon') {
        const outerOnly = coordinates.map((poly) => [poly[0]]);
        return turf.multiPolygon(outerOnly, feature.properties);
    }
    return feature;
}

// --------- Option B: build a single outer shell ----------
/**
 * @param {Feature|FeatureCollection} input
 * @param {{maxEdgeKm?:number, shellType?:"concave"|"convex"}} opts
 */
function buildOuterShell(input, { maxEdgeKm = 10, shellType = SHELL.CONCAVE } = {}) {
    const fc = input?.type === 'FeatureCollection' ? input : turf.featureCollection([input]);
    if (!fc?.features?.length) return null;

    const coords = turf.coordAll(fc);
    const points = turf.featureCollection(coords.map((c) => turf.point(c)));

    console.log(`shell: points=${points.features.length}, type=${shellType}, maxEdgeKm=${maxEdgeKm}`);

    if (shellType === SHELL.CONVEX) {
        console.time('shell:convex');
        const out = turf.convex(points) || turf.bboxPolygon(turf.bbox(points));
        console.timeEnd('shell:convex');
        return out;
    }

    // Default: concave shell → convex → bbox
    let shell = null;
    if (points.features.length >= 4) {
        console.time('shell:concave');
        try {
            shell = turf.concave(points, { maxEdge: maxEdgeKm });
        } catch {}
        console.timeEnd('shell:concave');
    }
    if (!shell) {
        console.time('shell:convex-fallback');
        shell = turf.convex(points);
        console.timeEnd('shell:convex-fallback');
    }
    if (!shell) {
        console.time('shell:bbox-fallback');
        shell = turf.bboxPolygon(turf.bbox(points));
        console.timeEnd('shell:bbox-fallback');
    }
    return shell;
}

// Optional: pre-simplify jaggy edges before shelling
function maybeSimplify(input, tolerance = 0) {
    if (!tolerance) return input;
    console.log(`simplify: tolerance=${tolerance}`);
    console.time('simplify');
    try {
        const out = turf.simplify(input, { tolerance, highQuality: false, mutate: false });
        console.timeEnd('simplify');
        return out;
    } catch {
        console.timeEnd('simplify');
        return input;
    }
}

// ---------- logging ----------
const logMissingZipCodes = async (directory, zipcodes) => {
    if (!directory || !Array.isArray(zipcodes) || !zipcodes.length) return;

    const missing = [];
    for (const z of zipcodes) {
        const filePath = path.join(directory, `${z}.geojson`);
        try { await fs.access(filePath); } catch { missing.push(z); }
    }

    if (!missing.length) {
        console.log('missing-zip: all present');
        return;
    }

    const missingFilePath = path.join('./', 'missing-zip.txt');
    try {
        let existing = [];
        try {
            const existingData = await fs.readFile(missingFilePath, 'utf8');
            existing = existingData.split('\n').filter(Boolean);
        } catch (readErr) {
            if (readErr.code !== 'ENOENT') throw readErr;
        }
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
 * {
 *   "zipcodes": ["51242","99522", ...],
 *   "mode": "shell" | "no-holes",          // default: "no-holes"
 *   "shellType": "concave" | "convex",     // only for mode="shell" (default: "concave")
 *   "maxEdgeKm": 10,                        // concave hull tuning (increase to bridge gaps)
 *   "simplifyTolerance": 0.001              // optional pre-simplification (in degrees)
 * }
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

    const geojsonDirectory = './geojson-files'; // adjust path as needed

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

        // Optional smoothing before shell
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
 * POST /create-boundary
 * Build a polygon from raw points.
 * Body:
 * {
 *   "points": [[lng,lat], ...],
 *   "shellType": "concave" | "convex",
 *   "maxEdgeKm": 10
 * }
 */
app.post('/create-boundary', (req, res) => {
    const { points, shellType = SHELL.CONCAVE, maxEdgeKm = 10 } = req.body;
    if (!Array.isArray(points) || points.length < 3) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of at least three [lng,lat] points.' });
    }

    console.log(`\n=== /create-boundary (${points.length} points) shellType=${shellType}, maxEdgeKm=${maxEdgeKm} ===`);

    try {
        const fc = turf.featureCollection(points.map((p) => turf.point(p)));
        let poly = null;

        if (shellType === SHELL.CONVEX) {
            console.time('create:convex');
            poly = turf.convex(fc) || turf.bboxPolygon(turf.bbox(fc));
            console.timeEnd('create:convex');
        } else {
            if (points.length >= 4) {
                console.time('create:concave');
                try { poly = turf.concave(fc, { maxEdge: maxEdgeKm }); } catch {}
                console.timeEnd('create:concave');
            }
            if (!poly) {
                console.time('create:convex-fallback');
                poly = turf.convex(fc);
                console.timeEnd('create:convex-fallback');
            }
            if (!poly) {
                console.time('create:bbox-fallback');
                poly = turf.bboxPolygon(turf.bbox(fc));
                console.timeEnd('create:bbox-fallback');
            }
        }

        // Ensure rings are closed
        if (poly.geometry.type === 'Polygon') {
            poly.geometry.coordinates = poly.geometry.coordinates.map((ring) => {
                const first = ring[0];
                const last = ring[ring.length - 1];
                return (first[0] !== last[0] || first[1] !== last[1]) ? [...ring, first] : ring;
            });
        }

        console.log('create: done ✅');
        return res.json(poly);
    } catch (error) {
        console.error('create: error ❌', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ---------- start ----------
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
