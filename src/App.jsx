import React, { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { v4 as uuidv4 } from 'uuid';

// Configuration: Backend API URL and Socket.IO connection
const API_URL = 'http://localhost:5000'; // Backend server URL - adjust if needed
const socket = io(API_URL); // Initialize Socket.IO connection for real-time collaboration

function App() {
  // Auth state
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user');
    return stored ? JSON.parse(stored) : null;
  });
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'register'
  const [authForm, setAuthForm] = useState({ email: '', password: '', username: '' });
  const [authError, setAuthError] = useState('');

  // Document state
  const [documents, setDocuments] = useState([]);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [content, setContent] = useState('');
  const isRemote = useRef(false);

  // ===== JOIN DOCUMENT STATE =====
  // Link input for joining shared documents
  const [joinLink, setJoinLink] = useState('');
  // Error message for join document attempts
  const [joinError, setJoinError] = useState('');
  // Success message for join document attempts
  const [joinSuccess, setJoinSuccess] = useState('');

  // Video call state
  const [inCall, setInCall] = useState(false);
  const [myPeer, setMyPeer] = useState(null);
  const [myStream, setMyStream] = useState(null);
  const [peers, setPeers] = useState({}); // peerId -> call
  const videoRefs = useRef({}); // peerId -> video ref

  // On mount, check for ?doc=ID in URL and auto-select after login
  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams(window.location.search);
    const docId = params.get('doc');
    if (docId && documents.length > 0) {
      const doc = documents.find(d => d._id === docId);
      if (doc) handleSelectDoc(doc);
    }
    // eslint-disable-next-line
  }, [token, documents]);

  // ===== FETCH USER DOCUMENTS =====
  // Load all documents owned by the current user when token changes
  useEffect(() => {
    if (!token) return; // Only fetch if user is authenticated
    fetch(`${API_URL}/api/documents`, {
      headers: { Authorization: `Bearer ${token}` }, // Include JWT token
    })
      .then(async res => {
        if (res.status === 401) {
          handleLogout(); // Token invalid/expired, log out user
          return [];
        }
        const docs = await res.json();
        return Array.isArray(docs) ? docs : [];
      })
      .then(docs => setDocuments(docs))
      .catch(err => {
        console.error('Failed to fetch documents:', err);
        setDocuments([]); // Always set to array on error
      });
  }, [token]);

  // Join document room and listen for updates
  useEffect(() => {
    if (!selectedDoc) return;
    socket.emit('join-document', selectedDoc._id);
    setContent(selectedDoc.content);
    socket.on('document-updated', (newContent) => {
      isRemote.current = true;
      setContent(newContent);
    });
    return () => {
      socket.off('document-updated');
    };
  }, [selectedDoc]);

  // Auth handlers
  const handleAuthChange = e => setAuthForm(f => ({ ...f, [e.target.name]: e.target.value }));
  const handleAuthSubmit = async e => {
    e.preventDefault();
    setAuthError('');
    try {
      // Send auth request to backend
      const res = await fetch(`${API_URL}/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authForm),
      });
      const data = await res.json();
      if (authMode === 'login') {
        if (!res.ok) throw new Error(data.message || 'Auth failed');
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
      } else {
        setAuthMode('login');
      }
    } catch (err) {
      setAuthError(err.message);
    }
  };
  const handleLogout = () => {
    setToken('');
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setSelectedDoc(null);
    setContent('');
  };

  // Document CRUD
  const handleSelectDoc = async doc => {
    setSelectedDoc(doc);
    // Fetch the latest content from server to ensure we have the most recent version
    try {
      const res = await fetch(`${API_URL}/api/documents/${doc._id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setContent(data.content);
    } catch (err) {
      console.error('Failed to fetch document content:', err);
      setContent(''); // Clear content on error
    }
  };
  const handleCreateDoc = async () => {
    const title = prompt('Document title?');
    if (!title) return;
    try {
      const res = await fetch(`${API_URL}/api/documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, content: '' }), // Start with empty content
      });
      const doc = await res.json();
      setDocuments(docs => [...docs, doc]);
    } catch (err) {
      console.error('Failed to create document:', err);
    }
  };
  const handleDeleteDoc = async docId => {
    try {
      await fetch(`${API_URL}/api/documents/${docId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
    setDocuments(docs => docs.filter(d => d._id !== docId));
    if (selectedDoc && selectedDoc._id === docId) setSelectedDoc(null);
  };

  // Join Document handler
  const handleJoinDocument = async () => {
    setJoinError('');
    setJoinSuccess(''); // Clear previous success message
    
    if (!joinLink.trim()) {
      setJoinError('Please enter a shared link');
      return;
    }
    
    try {
      // Extract document ID from various link formats
      let docId;
      if (joinLink.includes('?doc=')) {
        docId = joinLink.split('?doc=')[1];
      } else if (joinLink.includes('/documents/')) {
        docId = joinLink.split('/documents/')[1];
      } else {
        // Assume it's just the document ID
        docId = joinLink.trim();
      }
      
      if (!docId) {
        throw new Error('Invalid link format. Please check the shared link.');
      }

      // Fetch the document to verify it exists and user has access
      const res = await fetch(`${API_URL}/api/documents/${docId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error('Document not found. Check if the link is correct.');
        } else if (res.status === 401) {
          throw new Error('You do not have access to this document.');
        } else {
          throw new Error('Failed to join document. Please try again.');
        }
      }
      
      const data = await res.json();
      
      // Set the document as selected and join the room
      setSelectedDoc(data);
      setContent(data.content);
      socket.emit('join-document', docId);
      
      // Clear the input and show success
      setJoinLink('');
      setJoinSuccess(`Successfully joined: ${data.title}`);
      console.log('Successfully joined document:', data.title);
      
    } catch (err) {
      setJoinError(err.message || 'Failed to join document');
      console.error('Join document error:', err);
    }
  };

  // Editor change handler
  const handleEditorChange = async value => {
    setContent(value);
    if (!selectedDoc) return;
    if (!isRemote.current) {
      socket.emit('edit-document', { documentId: selectedDoc._id, content: value });
      // Save changes to database for persistence
      try {
        await fetch(`${API_URL}/api/documents/${selectedDoc._id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: value }),
        });
      } catch (err) {
        console.error('Failed to save document changes:', err);
      }
    }
    isRemote.current = false;
  };

  // Join video call handler
  const handleJoinVideoCall = async () => {
    if (inCall || !selectedDoc) return;
    setInCall(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setMyStream(stream);
      // Create PeerJS instance with random ID
      const peer = new Peer(undefined, { debug: 2 });
      setMyPeer(peer);
      // When peer is open, join the room
      peer.on('open', (id) => {
        socket.emit('join-video', { docId: selectedDoc._id, peerId: id });
      });
      // Answer incoming calls
      peer.on('call', call => {
        call.answer(stream);
        call.on('stream', userVideoStream => {
          addPeerStream(call.peer, userVideoStream);
        });
        setPeers(prev => ({ ...prev, [call.peer]: call }));
      });
      // Listen for new users joining
      socket.on('user-joined-video', ({ peerId }) => {
        if (!peerId || peerId === peer.id) return;
        const call = peer.call(peerId, stream);
        call.on('stream', userVideoStream => {
          addPeerStream(peerId, userVideoStream);
        });
        setPeers(prev => ({ ...prev, [peerId]: call }));
      });
      // Remove peer on disconnect
      socket.on('user-left-video', ({ peerId }) => {
        if (videoRefs.current[peerId]) {
          videoRefs.current[peerId].srcObject = null;
          delete videoRefs.current[peerId];
        }
        setPeers(prev => {
          if (!prev[peerId]) return prev;
          prev[peerId].close && prev[peerId].close();
          const newPeers = { ...prev };
          delete newPeers[peerId];
          return newPeers;
        });
      });
      // Add your own stream
      addPeerStream('me', stream, true);
    } catch (err) {
      alert('Could not access camera/microphone.');
      setInCall(false);
    }
  };
  // Helper to add a video stream
  const addPeerStream = (peerId, stream, isSelf = false) => {
    if (!videoRefs.current[peerId]) {
      videoRefs.current[peerId] = document.createElement('video');
      videoRefs.current[peerId].autoplay = true;
      videoRefs.current[peerId].playsInline = true;
      if (isSelf) videoRefs.current[peerId].muted = true;
    }
    videoRefs.current[peerId].srcObject = stream;
    // Force update
    setPeers(p => ({ ...p }));
  };
  // Clean up on leave or unmount
  useEffect(() => {
    return () => {
      if (myPeer) myPeer.destroy();
      if (myStream) myStream.getTracks().forEach(track => track.stop());
      Object.values(peers).forEach(call => call.close && call.close());
      videoRefs.current = {};
      setInCall(false);
      setPeers({});
      setMyPeer(null);
      setMyStream(null);
    };
    // eslint-disable-next-line
  }, [selectedDoc]);

  // UI
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <form onSubmit={handleAuthSubmit} className="bg-white p-8 rounded shadow-md w-80">
          <h2 className="text-2xl font-bold mb-4">{authMode === 'login' ? 'Login' : 'Register'}</h2>
          {authMode === 'register' && (
            <input name="username" placeholder="Username" className="mb-2 w-full p-2 border rounded" value={authForm.username} onChange={handleAuthChange} required />
          )}
          <input name="email" type="email" placeholder="Email" className="mb-2 w-full p-2 border rounded" value={authForm.email} onChange={handleAuthChange} required />
          <input name="password" type="password" placeholder="Password" className="mb-4 w-full p-2 border rounded" value={authForm.password} onChange={handleAuthChange} required />
          {authError && <div className="text-red-500 mb-2">{authError}</div>}
          <button className="bg-blue-600 text-white w-full py-2 rounded mb-2" type="submit">{authMode === 'login' ? 'Login' : 'Register'}</button>
          <button type="button" className="text-blue-600 underline w-full" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
            {authMode === 'login' ? 'No account? Register' : 'Have an account? Login'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="p-4 bg-blue-600 text-white text-xl font-bold flex justify-between items-center">
        <span>Online Code Editor</span>
        {user && (
          <span className="ml-4 text-base font-normal">Welcome, {user.username}</span>
        )}
        <button onClick={handleLogout} className="bg-white text-blue-600 px-3 py-1 rounded">Logout</button>
      </header>
      <main className="p-4 flex gap-4 max-w-6xl mx-auto">
        {/* Document sidebar */}
        <aside className="w-64 bg-white rounded shadow p-4">
          {/* Join Document Section */}
          <div className="mb-4 p-3 bg-gray-50 rounded">
            <h3 className="font-bold text-sm mb-2">Join Document</h3>
            <div className="flex gap-1">
              <input
                type="text"
                placeholder="Paste shared link..."
                className="flex-1 text-xs p-2 border rounded"
                value={joinLink}
                onChange={(e) => {
                  setJoinLink(e.target.value);
                  setJoinError(''); // Clear error when typing
                  setJoinSuccess(''); // Clear success when typing
                }}
                onKeyPress={(e) => e.key === 'Enter' && handleJoinDocument()}
              />
              <button
                onClick={handleJoinDocument}
                className="bg-green-600 text-white px-2 py-1 rounded text-xs"
              >
                Join
              </button>
            </div>
            {joinError && <div className="text-red-500 text-xs mt-1">{joinError}</div>}
            {joinSuccess && <div className="text-green-500 text-xs mt-1">{joinSuccess}</div>}
            <div className="text-gray-500 text-xs mt-2">
              Paste a shared link to collaborate on someone else's document
            </div>
          </div>

          <div className="flex justify-between items-center mb-2">
            <span className="font-bold">Your Documents</span>
            <button 
              onClick={handleCreateDoc} 
              className="bg-blue-600 text-white px-2 py-1 rounded text-sm"
            >
              New
            </button>
          </div>
          <ul>
            {documents.map(doc => (
              <li key={doc._id} className={`flex justify-between items-center p-2 rounded cursor-pointer ${selectedDoc && selectedDoc._id === doc._id ? 'bg-blue-100' : ''}`}
                  onClick={() => handleSelectDoc(doc)}>
                <span className="truncate w-32">{doc.title}</span>
                <button onClick={e => { e.stopPropagation(); handleDeleteDoc(doc._id); }} className="text-red-500 ml-2">Delete</button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="flex-1">
          {selectedDoc ? (
            <>
              {/* Video Call UI */}
              <div className="mb-4 flex items-center gap-4">
                <button
                  className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded shadow font-semibold transition"
                  onClick={handleJoinVideoCall}
                  disabled={inCall}
                  title="Coming soon!"
                >
                  <svg className="inline-block w-5 h-5 mr-2 -mt-1" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 19h8a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                  Join Video Call
                </button>
                <span className="text-gray-500 text-sm">(Collaborate face-to-face while editing!)</span>
              </div>
              {/* Placeholder for video call panel */}
              {inCall ? (
                <div className="flex flex-wrap gap-2 justify-center items-center">
                  {Object.entries(videoRefs.current).map(([peerId, videoEl]) => (
                    <video
                      key={peerId}
                      ref={el => {
                        if (el && videoEl && el !== videoEl) {
                          el.srcObject = videoEl.srcObject;
                        }
                      }}
                      className="w-40 h-32 bg-black rounded shadow"
                      autoPlay
                      playsInline
                      muted={peerId === 'me'}
                    />
                  ))}
                </div>
              ) : (
                <span className="text-lg font-medium">Video call panel will appear here</span>
              )}
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm text-gray-600">Share link:</span>
                <input
                  className="border px-2 py-1 rounded w-96 text-xs"
                  value={`${window.location.origin}?doc=${selectedDoc._id}`}
                  readOnly
                  onFocus={e => e.target.select()}
                />
              </div>
              <Editor
                height="70vh"
                defaultLanguage="javascript"
                value={content}
                onChange={handleEditorChange}
              />
            </>
          ) : (
            <div className="text-gray-500 text-center mt-20">Select or create a document to start editing.</div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App; 