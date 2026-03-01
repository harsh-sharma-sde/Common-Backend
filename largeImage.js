const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { encode } = require('blurhash');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

/** * --- SDE3: PERSISTENCE & INFRASTRUCTURE INITIALIZATION ---
 * In a production environment, these would be handled by:
 * 1. Infrastructure-as-Code (Terraform/CDK) for directory mounting.
 * 2. A real Database (PostgreSQL/MongoDB) instead of a JSON file.
 * 3. A dedicated File Storage service (AWS S3/GCS).
 */
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const RAW_DIR = path.join(__dirname, 'uploads/raw');
const DB_FILE = path.join(__dirname, 'db.json');

// Ensure idempotent directory creation on startup
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });

// Mock Database Initialization: Ensures the application doesn't crash on the first READ
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

/**
 * ATOMIC WRITE SIMULATION
 * Note: fs.writeFileSync is blocking and not suitable for high-concurrency.
 * In a real system, we would use an ACID-compliant DB to prevent data corruption.
 */
const saveToDb = (data) => {
    db.push(data);
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
};

// ------------------------------------------

// Serve static assets via Express (In production, move this to a CDN/Nginx for better performance)
app.use('/uploads', express.static('uploads'));

/**
 * MULTER CONFIGURATION
 * Strategy: Temporary disk storage for raw uploads. 
 * Prevents memory exhaustion for large files compared to MemoryStorage.
 */
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, RAW_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

/**
 * POST /upload
 * Logic: Image Processing Pipeline
 * 1. Validation & Metadata extraction.
 * 2. BlurHash generation (UX: provides immediate visual feedback/placeholder).
 * 3. Format conversion (Optimization: WebP for better compression).
 * 4. Cleanup (Storage Management).
 */
app.post('/upload', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).send('No image uploaded.');

    const targetName = `processed-${Date.now()}.webp`;
    const outputPath = path.join(UPLOADS_DIR, targetName);

    try {
        const image = sharp(req.file.path);
        const metadata = await image.metadata();

        /**
         * BLURHASH GENERATION (Perceptual Hashing)
         * Purpose: Create a 20-30 byte string that the frontend can use to 
         * render a blurred placeholder instantly, solving the "blank white box" problem.
         * We downsample to 32x32 to keep the hash generation CPU-efficient.
         */
        const { data, info } = await image
            .raw()
            .ensureAlpha()
            .resize(32, 32, { fit: 'inside' })
            .toBuffer({ resolveWithObject: true });
        
        const hash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);

        /**
         * IMAGE OPTIMIZATION (WebP)
         * We convert to WebP at 80% quality to significantly reduce payload size
         * while maintaining visual fidelity for the Masonry grid.
         */
        await image.webp({ quality: 80 }).toFile(outputPath);

        /**
         * METADATA PAYLOAD
         * Crucial: We include 'width', 'height', and 'aspect_ratio' so the frontend
         * can calculate the Masonry layout height BEFORE the image is downloaded.
         */
        const imageData = {
            id: Date.now(),
            url: `http://localhost:5000/uploads/${targetName}`,
            width: metadata.width,
            height: metadata.height,
            aspect_ratio: metadata.width / metadata.height,
            blurhash: hash,
        };

        saveToDb(imageData);
        
        // Storage Hygiene: Remove the original high-res/unoptimized file immediately after processing
        fs.unlinkSync(req.file.path);

        res.status(201).json(imageData);
    } catch (err) {
        console.error("Image Processing Pipeline Error:", err);
        res.status(500).json({ error: "Processing failed" });
    }
});

/**
 * GET /feed
 * Strategy: Pagination should be implemented here in a real-world scenario (limit/offset)
 * to avoid sending the entire DB to the client at once.
 */
app.get('/feed', (req, res) => {
    res.json(db);
});

app.listen(5000, () => console.log('Backend running on http://localhost:5000'));