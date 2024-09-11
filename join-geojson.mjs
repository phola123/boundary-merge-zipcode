import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as turf from '@turf/turf';

const app = express();
const port = 8002;  // Port number

// Middleware to parse JSON request bodies
app.use(express.json());

// Helper function to read GeoJSON files
const readGeoJSON = async (filePath) => {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
};

// Load specific GeoJSON files based on zip codes
const loadGeoJSONFiles = async (directory, zipcodes) => {
    const geojsonPromises = zipcodes.map(zipcode => {
        const filePath = path.join(directory, `${zipcode}.geojson`);
        return fs.access(filePath) // Check if the file exists
            .then(() => readGeoJSON(filePath)) // Read the file if it exists
            .catch(() => null); // Return null if file does not exist
    });
    return Promise.all(geojsonPromises);
};

// Merge multiple GeoJSON features
const mergeGeoJSONFeatures = (geojsons) => {
    const allFeatures = geojsons.filter(Boolean).flatMap(geojson => geojson.features);
    return turf.featureCollection(allFeatures);
};

// Get the precise outer boundary of the merged features
const getOuterBoundary = (featureCollection) => {
    if (featureCollection.features.length === 0) {
        return turf.featureCollection([]); // Return an empty feature collection if no features
    }

    // Initialize the union feature with the first feature
    let unionFeature = featureCollection.features[0];

    // Union all features to get a combined feature
    for (let i = 1; i < featureCollection.features.length; i++) {
        unionFeature = turf.union(unionFeature, featureCollection.features[i]);
    }

    // Optionally, apply a buffer to smoothen the boundaries
    // Adjust the buffer distance as needed (e.g., 0.0001 degrees)
    // unionFeature = turf.buffer(unionFeature, 0.0001, { units: 'degrees' });

    return unionFeature;
};

// Create GeoJSON boundary from latitude and longitude points (this can be used for in out territories)
const createBoundaryFromPoints = (points) => {
    if (points.length < 3) {
        throw new Error('At least three points are required to create a boundary.');
    }

    // Create a FeatureCollection from the points
    const pointFeatures = points.map(point => turf.point(point));
    const featureCollection = turf.featureCollection(pointFeatures);

    // Compute the convex hull (boundary)
    const convexHull = turf.convex(featureCollection);

    return convexHull;
};

// Endpoint to process zip codes
app.post('/process-zipcodes', async (req, res) => {
    const { zipcodes } = req.body;
    if (!Array.isArray(zipcodes) || zipcodes.length === 0) {
        return res.status(400).json({ error: 'Invalid input. Expected a non-empty array of zip codes.' });
    }

    try {
        // Directory containing GeoJSON files
        const geojsonDirectory = './geojson-files'; // Update this path as needed

        // Load GeoJSON files specific to the given zip codes
        const geojsons = await loadGeoJSONFiles(geojsonDirectory, zipcodes);

        // Process GeoJSON data
        const mergedFeatures = mergeGeoJSONFeatures(geojsons);
        const outerBoundary = getOuterBoundary(mergedFeatures);

        // Send the result
        res.json(outerBoundary);
    } catch (error) {
        console.error('Error processing GeoJSON files:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



// New endpoint to create a boundary from latitude and longitude points
app.post('/create-boundary', (req, res) => {
    const { points } = req.body;
    if (!Array.isArray(points) || points.length < 3) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of at least three points.' });
    }

    try {
        // Create GeoJSON boundary from the provided points
        const boundary = createBoundaryFromPoints(points);

        // Send the result
        res.json(boundary);
    } catch (error) {
        console.error('Error creating boundary:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});




app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
