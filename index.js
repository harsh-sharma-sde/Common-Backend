const express = require('express');
const cors = require('cors');
const multer = require('multer'); // Middleware for handling 'multipart/form-data' (file uploads)
const { v4: uuidv4 } = require('uuid'); // Generates unique IDs for every video/lesson
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg'); // The tool that actually "slices" the video
const ffmpegPath = require('ffmpeg-static'); // Provides a binary for FFmpeg so you don't have to install it on your OS manually

// Point fluent-ffmpeg to the static binary we just imported
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

/**
 * 🛠️ MIDDLEWARE
 */
app.use(cors({
    origin: ["http://localhost:3000", "http://localhost:5173"], // Allows React (Vite/CRA) to talk to this server
    credentials: true
}));

app.use(express.json()); // Parses JSON bodies
app.use(express.urlencoded({ extended: true }));

/**
 * 📂 FOLDER SETUP
 * We need two main folders:
 * 1. uploads: Where the raw .mp4 goes first.
 * 2. processed: Where the .m3u8 playlist and .ts segments are stored.
 */
const uploadDir = './videos/uploads';
const processedDir = './videos/processed';

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

/**
 * 💾 MULTER STORAGE CONFIGURATION
 * This defines WHERE the file goes on the disk and WHAT it should be named.
 */
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir); // Save raw uploads here
    },
    filename: function (req, file, cb) {
        // Create a unique filename: e.g., "file-uuid.mp4"
        cb(null, file.fieldname + '-' + uuidv4() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

/**
 * 🌐 STATIC FILE SERVING
 * This turns your local folder into a mini-CDN. 
 * When the browser asks for /uploads/processed/..., Express looks in the /videos folder.
 */
app.use('/uploads', express.static('videos'));

/**
 * 🗄️ IN-MEMORY DATABASE
 * A simple object to track video status (processing, ready, or failed).
 * Key: unique ID, Value: Video object.
 */
const videoDB = {}; 

/**
 * 🟢 ROUTE: UPLOAD & TRANSCODE
 * This is the most important part of the backend.
 */
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
    }

    const lessonId = uuidv4(); // Unique ID for this specific video session
    const videoPath = req.file.path; // Path to the raw .mp4 file
    const outputPath = `${processedDir}/${lessonId}`; // Folder where segments will live
    const hlsPath = `${outputPath}/index.m3u8`; // The main "Master Playlist" file

    // Create a sub-folder specifically for this video's segments
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
    }

    // Add entry to our "Database" with status 'processing'
    videoDB[lessonId] = {
        id: lessonId,
        status: 'processing',
        originalName: req.file.originalname,
        // The URL your frontend VideoPlayer will call
        videoUrl: `http://localhost:8000/uploads/processed/${lessonId}/index.m3u8`
    };

    /**
     * 🎞️ THE HLS TRANSCODING ENGINE
     * We use FFmpeg to convert 1 large MP4 into many small 10-second TS chunks.
     * This allows the player to start playing almost instantly.
     */
    const ffmpegCommand = ffmpeg(videoPath)
        .addOptions([
            '-profile:v baseline', // Best compatibility for web/mobile browsers
            '-level 3.0',           
            '-start_number 0',      
            '-hls_time 10',        // Split video into 10-second segments
            '-hls_list_size 0',    // Keep all segments in the playlist (don't delete old ones)
            '-f hls'               // Force the output format to HLS
        ])
        .output(hlsPath) // Save the .m3u8 and .ts files here
        .on('end', () => {
            // Once FFmpeg finishes, mark the video as 'ready'
            console.log(`✅ Processing finished for ${lessonId}`);
            videoDB[lessonId].status = 'ready';
            
            // OPTIONAL: Delete the original raw MP4 here to save space
            // fs.unlinkSync(videoPath); 
        })
        .on('error', (err) => {
            console.error('❌ FFmpeg Error:', err);
            videoDB[lessonId].status = 'failed';
        });
    
    // EXECUTE: Start the heavy lifting in the background
    ffmpegCommand.run();

    // IMMEDIATE RESPONSE: Tell the frontend we got the file and are working on it.
    // We don't wait for FFmpeg to finish before sending this.
    res.json({
        message: "Video uploaded and processing started",
        videoId: lessonId,
        videoUrl: videoDB[lessonId].videoUrl
    });
});

/**
 * 🟢 ROUTE: FETCH ALL VIDEOS
 * Used by the frontend grid to show available content.
 */
app.get('/videos', (req, res) => {
    // Return the database objects as an array
    res.json(Object.values(videoDB));
});

const PORT = 8000;
app.listen(PORT, () => {
    console.log(`🚀 Video Streaming Backend running on port ${PORT}`);
});