const Y = require('yjs')

// y-protocols: Helper functions to handle the specific binary format Yjs uses
const syncProtocol = require('y-protocols/dist/sync.cjs')           // Handles document data syncing
const awarenessProtocol = require('y-protocols/dist/awareness.cjs') // Handles cursors/presence

// lib0: A highly optimized library for binary encoding/decoding (used internally by Yjs)
const encoding = require('lib0/dist/encoding.cjs')
const decoding = require('lib0/dist/decoding.cjs')
const map = require('lib0/dist/map.cjs')

// WebSocket Status Constants
const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1

// Garbage Collection (GC): cleans up deleted text history.
// We usually keep it enabled to save memory, unless we are doing complex undo/redo logic server-side.
const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0'

// THE MASTER MAP:
// This holds all active documents in memory. 
// Key = Document Name (e.g., "my-document"), Value = WSSharedDoc instance
const docs = new Map()

// Message Types (Protocol ID)
// 0 = Sync Message (Text changes, document updates)
// 1 = Awareness Message (Cursor movements, user names)
const messageSync = 0
const messageAwareness = 1

/**
 * Update Handler
 * Triggered when the Yjs document changes (e.g., someone typed).
 * It encodes the change into a binary message and broadcasts it to ALL other connections.
 */
const updateHandler = (update, origin, doc) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync) // Write Protocol ID (0)
  syncProtocol.writeUpdate(encoder, update)   // Write the actual data change
  const message = encoding.toUint8Array(encoder)
  
  // Loop through all connected clients for this doc and send the update
  doc.conns.forEach((_, conn) => send(doc, conn, message))
}

/**
 * WSSharedDoc
 * This class extends the standard Y.Doc to add server-side specific logic.
 * It manages the list of WebSocket connections and the "Awareness" (presence) instance.
 */
class WSSharedDoc extends Y.Doc {
  constructor (name) {
    super({ gc: gcEnabled })
    this.name = name
    
    // Map of all WebSocket connections looking at this document
    this.conns = new Map()
    
    // Awareness: Keeps track of who is online (cursors, names, colors)
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null) // Server doesn't have a cursor

    // Handler for when Awareness changes (someone joined, left, or moved cursor)
    const awarenessChangeHandler = ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated).concat(removed)
      const connControlledIDs = new Set()
      
      // Associate ClientIDs with Connections to know who to disconnect later
      this.conns.forEach((_, conn) => {
        if (conn.controlledUserNumbers) {
          conn.controlledUserNumbers.forEach(clock => connControlledIDs.add(clock))
        }
      })

      // If the change came from the server itself, ignore
      if (origin === 'custom') {
        return
      }

      // Encode the Awareness update to binary
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness) // Protocol ID (1)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
      const buff = encoding.toUint8Array(encoder)

      // Broadcast the cursor movement to everyone
      this.conns.forEach((_, conn) => {
        send(this, conn, buff)
      })
    }

    // Attach listeners
    this.awareness.on('update', awarenessChangeHandler)
    this.on('update', updateHandler)
  }
}

/**
 * getYDoc
 * A Singleton-like helper.
 * If the document exists in memory, return it.
 * If not, create a new WSSharedDoc and store it in the 'docs' Map.
 */
const getYDoc = (docname, gc = true) => map.setIfUndefined(docs, docname, () => {
  const doc = new WSSharedDoc(docname)
  doc.gc = gc
  
  // NOTE: If you wanted to load data from a database (MongoDB/Postgres),
  // you would trigger the DB load here before returning the doc.
  
  return doc
})

/**
 * messageListener
 * The main switchboard. It runs every time the server receives a message from a client.
 */
const messageListener = (conn, doc, message) => {
  // Use lib0 to decode the binary message
  const encoder = encoding.createEncoder()
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder) // Read first byte (0 or 1)

  switch (messageType) {
    case messageSync:
      // It's a document update (text typed)
      encoding.writeVarUint(encoder, messageSync)
      // Read the sync message and apply it to the server's copy of the doc
      syncProtocol.readSyncMessage(decoder, encoder, doc, null)
      
      // If the sync protocol generated a response (e.g., asking for missing data), send it back
      if (encoding.length(encoder) > 1) {
        send(doc, conn, encoding.toUint8Array(encoder))
      }
      break
      
    case messageAwareness:
      // It's a presence update (cursor moved)
      // Apply the update to the server's awareness instance so we can broadcast it
      awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
      break
  }
}

/**
 * closeConn
 * Cleanup logic when a user disconnects.
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    // Get the User IDs associated with this specific connection
    const controlledIds = doc.conns.get(conn)
    doc.conns.delete(conn)

    // Remove their cursor/color from the Awareness instance
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)

    // If NO ONE is left in the document
    if (doc.conns.size === 0) {
      // NOTE: If you are using a Database, you would SAVE the document to the DB here.
      
      // Destroy the doc to free up RAM
      doc.destroy()
      docs.delete(doc.name)
    }
  }
  conn.close()
}

/**
 * send
 * A safe wrapper around WebSocket.send()
 * Handles errors (like if the connection dropped mid-transfer).
 */
const send = (doc, conn, m) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn)
  }
  try {
    conn.send(m, err => { if (err != null) closeConn(doc, conn) })
  } catch (e) {
    closeConn(doc, conn)
  }
}

/**
 * setupWSConnection
 * The entry point called by server.js.
 * Sets up the "Ping Pong" between server and client.
 */
const setupWSConnection = (conn, req, { docName = req.url.slice(1), gc = true } = {}) => {
  // Yjs requires binary data (ArrayBuffer), not Blobs or Strings
  conn.binaryType = 'arraybuffer'
  
  // 1. Get the document (create if new, fetch if existing)
  const doc = getYDoc(docName, gc)
  
  // 2. Register the connection
  doc.conns.set(conn, new Set())
  
  // 3. Listen for incoming messages (Type or Move Cursor)
  conn.on('message', message => messageListener(conn, doc, new Uint8Array(message)))
  
  // 4. Handle disconnects
  conn.on('close', () => closeConn(doc, conn))
  
  // 5. INITIATE SYNC: "Step 1"
  // The server immediately sends a "Sync Step 1" message.
  // This tells the client: "Here is the state vector (summary) of what I have. What do you have?"
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(doc, conn, encoding.toUint8Array(encoder))
  
  // 6. SEND AWARENESS
  // Send the current list of users (who is already online) to the new user.
  const awarenessStates = doc.awareness.getStates()
  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())))
    send(doc, conn, encoding.toUint8Array(encoder))
  }
}

module.exports = { setupWSConnection }