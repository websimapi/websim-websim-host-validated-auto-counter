import { WebsimSocket } from "@websim/websim-socket";

/*
  Host-Validated Auto Counter
  - Uses WebsimSocket collections & presence.
  - Collection used: "leaderboard"
  - Each leaderboard row has shape:
    {
      id: user_id,        // primary key (use current user's id for upsert)
      score: number,
      updated_at: ISO timestamp (optional)
    }
  Behavior:
  - The project creator (host) is the only client that will perform the per-second increment of everyone's score.
  - Host auto increments every connected peer (including host) by +1 each second while host-auto is enabled.
  - Anyone can view the leaderboard in realtime (we subscribe to the collection).
  - Host can reset leaderboard (only host can perform reset; button is hidden/inactive for non-hosts).
*/

const room = new WebsimSocket();

let currentUser = null;
let creator = null;
let peers = {}; // room.peers
let presence = {};
let isHostClient = false;
let hostAutoEnabled = true; // toggle via button (host-only)
let hostInterval = null;

const els = {
  clientName: document.getElementById("client-name"),
  creatorUsername: document.getElementById("creator-username"),
  hostDot: document.getElementById("host-dot"),
  rows: document.getElementById("rows"),
  info: document.getElementById("info"),
  refreshPeersBtn: document.getElementById("refresh-peers"),
  resetLeaderboardBtn: document.getElementById("reset-leaderboard"),
  toggleAutoBtn: document.getElementById("toggle-auto")
};

async function init() {
  els.info.textContent = "Connecting...";
  await room.initialize();

  // get current user and creator info via window.websim helper functions
  try {
    currentUser = await window.websim.getCurrentUser();
  } catch (e) {
    // fallback: try room.peers lookup
    currentUser = { id: room.clientId, username: (room.peers?.[room.clientId]?.username) || `client-${room.clientId}` };
  }

  try {
    creator = await window.websim.getCreator();
  } catch (e) {
    // fallback: if not available, attempt to guess first peer as creator (best-effort)
    creator = null;
  }

  updateClientLabel();

  // subscribe to peers + presence updates
  room.subscribePresence((p) => {
    presence = p;
    peers = room.peers || {};
    updateClientLabel();
    refreshPeersList();
  });

  room.subscribeRoomState((rs) => {
    // not used heavily here, but kept up to date
  });

  // Hook up UI actions
  els.refreshPeersBtn.addEventListener("click", refreshPeersList);
  els.resetLeaderboardBtn.addEventListener("click", resetLeaderboard);
  els.toggleAutoBtn.addEventListener("click", toggleHostAuto);

  // Subscribe to leaderboard collection realtime changes and render
  const lbCollection = room.collection("leaderboard");
  let unsubscribeLB = lbCollection.subscribe(renderLeaderboard);
  // initial load
  const initial = await lbCollection.getList();
  renderLeaderboard(initial);

  // monitor host state and start/stop host counting accordingly
  startHostWatch();

  els.info.textContent = "Connected. Waiting for updates...";
}

// update client and host UI elements
function updateClientLabel() {
  const username = currentUser?.username || room.peers?.[room.clientId]?.username || `client-${room.clientId}`;
  els.clientName.textContent = username;
  els.creatorUsername.textContent = creator?.username || "(unknown)";

  // determine host status: a client is host if their user id equals creator.id AND they are connected
  isHostClient = false;
  if (creator && currentUser && creator.id === currentUser.id) {
    isHostClient = true;
  }

  // update indicator color
  if (isHostClient) {
    els.hostDot.classList.remove("not-host");
    els.hostDot.classList.add("host-ind");
    els.hostDot.title = "You are the creator (host)";
  } else {
    // also color green if the host is currently connected (creator present among peers)
    const creatorConnected = creator && Object.values(room.peers || {}).some(p => p.username === creator.username);
    els.hostDot.classList.remove("host-ind");
    els.hostDot.classList.add("not-host");
    els.hostDot.title = creatorConnected ? "Host is connected" : "Host is not connected";
  }

  // enable/disable buttons according to host status
  els.resetLeaderboardBtn.disabled = !isHostClient;
  els.toggleAutoBtn.style.display = isHostClient ? "inline-block" : "none";
}

// Render leaderboard entries (collection records array)
function renderLeaderboard(records = []) {
  // records might be an object depending on library; we assume it's an array.
  const rows = Array.isArray(records) ? records.slice() : [];
  // sort descending by score
  rows.sort((a, b) => (b.score || 0) - (a.score || 0));

  // clear and render
  els.rows.innerHTML = "";
  if (rows.length === 0) {
    els.rows.innerHTML = `<div class="muted">No scores yet.</div>`;
    return;
  }

  for (const r of rows) {
    const userId = r.id || r.user_id || r.userId;
    const score = r.score || 0;
    // look up username via peers / user collection if available
    // We can show avatar by username when present: https://images.websim.com/avatar/${username}
    let username = r.username || (room.peers && Object.values(room.peers).find(p => p.id === userId)?.username) || r.user?.username || `user-${userId.slice(0,6)}`;
    const avatarUrl = username ? `https://images.websim.com/avatar/${username}` : null;

    const div = document.createElement("div");
    div.className = "entry";
    div.setAttribute("role", "listitem");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    if (avatarUrl) {
      const img = document.createElement("img");
      img.src = avatarUrl;
      img.alt = username;
      avatar.appendChild(img);
    } else {
      avatar.textContent = username.slice(0,1).toUpperCase();
    }

    const nameWrap = document.createElement("div");
    const nameEl = document.createElement("div");
    nameEl.className = "username";
    nameEl.textContent = "@" + username;
    const meta = document.createElement("div");
    meta.className = "small muted";
    meta.textContent = `id: ${userId}`;

    nameWrap.appendChild(nameEl);
    nameWrap.appendChild(meta);

    const scoreEl = document.createElement("div");
    scoreEl.className = "score";
    scoreEl.textContent = (score).toString();

    // If the row corresponds to the creator, mark it
    if (creator && userId === creator.id) {
      const hostBadge = document.createElement("span");
      hostBadge.className = "small muted";
      hostBadge.textContent = " host";
      nameEl.appendChild(hostBadge);
    }

    div.appendChild(avatar);
    div.appendChild(nameWrap);
    div.appendChild(scoreEl);
    els.rows.appendChild(div);
  }
}

// Refresh peers list (ad-hoc)
function refreshPeersList() {
  const p = room.peers || {};
  const count = Object.keys(p).length;
  els.info.textContent = `Connected peers: ${count}`;
  // Also update creator indicator to show if host is present
  updateClientLabel();
}

// Host: per-second increment logic
async function hostTick() {
  if (!creator) return;
  // ensure creator is still connected in peers
  const peersList = room.peers || {};
  const creatorConnected = Object.values(peersList).some(x => x.username === creator.username || x.id === creator.id);
  if (!creatorConnected) {
    // stop host interval if host disconnected
    stopHostInterval();
    els.info.textContent = "Creator (host) not connected. Counting stopped.";
    return;
  }

  // fetch current leaderboard to avoid overwriting unknown rows
  const lb = room.collection("leaderboard");
  const currentRecords = await lb.getList(); // array of records

  // Build map for quick lookup
  const map = new Map();
  for (const rec of currentRecords) {
    map.set(rec.id, rec);
  }

  // For each connected peer, upsert (id = user_id) increment score by 1
  // We will include peer info lookup for username where possible (not required but helpful)
  const now = new Date().toISOString();
  const upserts = [];
  for (const [clientId, p] of Object.entries(peersList)) {
    // We want to map client -> user id. room.peers entry includes id (clientId) and username; docs say user id available via window.websim.getCurrentUser() but peers entry has user info.
    // The database spec wants id to be the user's id (user_id). We will attempt to resolve user_id from p.id or from presence mapping.
    // Best-effort: if presence has user_id for clientId (room.presence may include studio user id), use it; otherwise use p.id (client id) as fallback.
    const clientPresence = room.presence?.[clientId] || {};
    const userId = clientPresence.user_id || p.user_id || p.id || clientId;
    const username = p.username || clientPresence.username || null;

    const prev = map.get(userId);
    const prevScore = prev ? (prev.score || 0) : 0;
    const newScore = prevScore + 1;

    const obj = {
      id: userId.toString(),
      score: newScore,
      updated_at: now
    };
    // store username minimally to help display (though tips advise to store user_id not username; we only store username optionally)
    if (!prev && username) obj.username = username;

    upserts.push(lb.upsert(obj));
  }

  try {
    await Promise.all(upserts);
    els.info.textContent = `Host tick: incremented ${upserts.length} users at ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error("Error performing host upserts", err);
    els.info.textContent = "Error incrementing scores (see console).";
  }
}

function startHostInterval() {
  if (hostInterval) return;
  hostInterval = setInterval(() => {
    hostTick();
  }, 1000);
  els.toggleAutoBtn.textContent = "Stop Host Auto Counting";
}

function stopHostInterval() {
  if (!hostInterval) return;
  clearInterval(hostInterval);
  hostInterval = null;
  els.toggleAutoBtn.textContent = "Start Host Auto Counting";
}

function startHostWatch() {
  // Watch for creator presence among peers; when the local client is the creator (host) we start the automatic ticking.
  // If the local client is not the creator, we still watch so UI can reflect host-connected status.
  // We'll re-evaluate every time presence or peers update.
  // For simplicity we poll room.peers every 1500ms as well to catch changes.
  setInterval(() => {
    // update cached creator value if possible
    // Some projects might not expose creator via window.websim.getCreator(); try to fetch from window.websim as well.
    (async () => {
      try {
        if (!creator) {
          const c = await window.websim.getCreator();
          if (c) {
            creator = c;
            updateClientLabel();
          }
        }
      } catch (e) {
        // ignore
      }

      // determine if the creator is currently connected
      const peersList = room.peers || {};
      const creatorConnected = creator && Object.values(peersList).some(p => p.username === creator.username || p.id === creator.id);

      // if this client is the host (creator) and hostAutoEnabled, ensure interval running
      if (isHostClient && hostAutoEnabled && creatorConnected) {
        startHostInterval();
      } else {
        // if host auto toggled off or host disconnected, stop interval
        if (!isHostClient || !hostAutoEnabled || !creatorConnected) {
          stopHostInterval();
        }
      }

      // Update UI host indicator
      updateClientLabel();
    })();
  }, 1500);
}

// Toggle host auto (host only)
function toggleHostAuto() {
  if (!isHostClient) return;
  hostAutoEnabled = !hostAutoEnabled;
  if (hostAutoEnabled) {
    startHostInterval();
    els.info.textContent = "Host auto counting enabled.";
  } else {
    stopHostInterval();
    els.info.textContent = "Host auto counting disabled.";
  }
}

// Reset leaderboard (host only)
async function resetLeaderboard() {
  if (!isHostClient) return;
  if (!confirm("Reset all leaderboard scores to zero? (host-only)")) return;
  const lb = room.collection("leaderboard");
  try {
    const recs = await lb.getList();
    const promises = [];
    for (const r of recs) {
      // upsert with score 0
      promises.push(lb.upsert({ id: r.id, score: 0, updated_at: new Date().toISOString() }));
    }
    await Promise.all(promises);
    els.info.textContent = "Leaderboard reset by host.";
  } catch (err) {
    console.error("Error resetting leaderboard", err);
    els.info.textContent = "Error resetting leaderboard (see console).";
  }
}

// initialize app
init().catch(err => {
  console.error("Failed to initialize:", err);
  document.getElementById("info").textContent = "Initialization error (see console).";
});

