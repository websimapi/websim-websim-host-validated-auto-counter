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
  - Host auto increments every connected user's leaderboard score by +1 each second while host-auto is enabled.
  - Anyone can view the leaderboard in realtime (we subscribe to the collection).
  - Host can reset leaderboard (only host can perform reset; button is hidden/inactive for non-hosts).
  - Important change: Only the host will author (create/upsert) leaderboard rows. When any user connects we
    request the host (via presence-update request) to ensure there is exactly one row for that user (id = user_id).
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

    // Ensure our row exists when presence changes (handles reconnects)
    // Non-host clients will request the host to ensure their row.
    // Host client will ensure its own row directly.
    ensureMyRowExists().catch(err => console.error("ensureMyRowExists error:", err));
  });

  room.subscribeRoomState((rs) => {
    // not used heavily here, but kept up to date
  });

  // Handle connection / disconnection messages from the low-level event stream.
  // This helps detect reconnects more reliably and trigger a fresh fetch of the leaderboard.
  room.onmessage = (event) => {
    const data = event.data || event;
    // built-in events: connected, disconnected
    if (data.type === "connected") {
      // Our client (or others) connected. Refresh local state & ensure row.
      // Fetch latest leaderboard snapshot and re-render to ensure continuity after reconnect.
      refreshLeaderboardSnapshot().catch(err => console.error("refreshLeaderboardSnapshot error:", err));
      // ensure our row exists (in case we just reconnected)
      ensureMyRowExists().catch(err => console.error("ensureMyRowExists error on init:", err));
    } else if (data.type === "disconnected") {
      // someone disconnected; update UI
      refreshPeersList();
    }
    // allow other custom events to exist
  };

  // Listen for presence-update requests (used to let clients ask the host to create/upsert their row)
  // Only meaningful when this client is the creator (host). The callback receives (updateRequest, fromClientId)
  room.subscribePresenceUpdateRequests(async (updateRequest, fromClientId) => {
    try {
      if (!isHostClient) return; // only host should respond to these
      if (!updateRequest || updateRequest.type !== "ensure_row") return;

      const userId = updateRequest.user_id;
      const username = updateRequest.username || null;

      if (!userId) return;

      const lb = room.collection("leaderboard");

      // Try to find existing record for this user id
      // Use filter fallback - some implementations expect id in primary column; filter works as equality query.
      let existing = [];
      try {
        existing = await lb.filter({ id: userId }).getList();
      } catch (err) {
        // fallback to full list and find (less optimal)
        const all = await lb.getList();
        existing = all.filter(r => (r.id === userId));
      }

      if (existing && existing.length > 0) {
        // There's already a row for this user. Ensure it has username if missing, but DO NOT overwrite score.
        const rec = existing[0];
        if ((!rec.username || rec.username === "") && username) {
          await lb.upsert({ id: userId, score: rec.score || 0, username, updated_at: new Date().toISOString() });
        }
      } else {
        // No existing row: create one with score 0 authored by host
        await lb.upsert({ id: userId, score: 0, username, updated_at: new Date().toISOString() });
      }

      // Optionally send an ephemeral event back to requester so they can refresh state (requester will get realtime update anyway)
      room.send({ type: "ensure_row_ack", echo: false, toClientId: fromClientId, user_id: userId });
    } catch (err) {
      console.error("Error handling ensure_row request:", err);
    }
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

  // On page load, ensure there is exactly one row for this user.
  // We MUST NOT create the row locally; only the host should author rows.
  // So: if the creator (host) is connected, send a presence-update request to the host asking them to ensure the row exists.
  // If creator not connected, inform user that their row will be created when host connects.
  ensureMyRowExists().catch(err => console.error("ensureMyRowExists error on init:", err));

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
    const creatorConnected = creator && Object.values(room.peers || {}).some(p => p.username === creator.username || p.id === creator.id);
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
  // dedupe by id to be safe (only 1 row per user desired)
  const uniqueMap = new Map();
  for (const r of rows) {
    const userId = r.id || r.user_id || r.userId;
    if (!userId) continue;
    // prefer higher score if duplicates exist
    const existing = uniqueMap.get(userId);
    if (!existing || (r.score || 0) > (existing.score || 0)) {
      uniqueMap.set(userId, r);
    }
  }
  const uniqRows = Array.from(uniqueMap.values());

  // sort descending by score
  uniqRows.sort((a, b) => (b.score || 0) - (a.score || 0));

  // clear and render
  els.rows.innerHTML = "";
  if (uniqRows.length === 0) {
    els.rows.innerHTML = `<div class="muted">No scores yet.</div>`;
    return;
  }

  for (const r of uniqRows) {
    const userId = r.id || r.user_id || r.userId;
    const score = r.score || 0;
    // look up username via peers / user collection if available
    // We can show avatar by username when present: https://images.websim.com/avatar/${username}
    let username = r.username || (room.peers && Object.values(room.peers).find(p => p.id === userId)?.username) || r.user?.username || `user-${(userId || "").toString().slice(0,6)}`;
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
  const now = new Date().toISOString();
  const upserts = [];
  for (const [clientId, p] of Object.entries(peersList)) {
    // Try to resolve actual user id for the peer:
    const clientPresence = room.presence?.[clientId] || {};
    // presence may contain user_id per docs; fallbacks to p.id or clientId
    const userId = clientPresence.user_id || p.user_id || p.id || clientId;
    const username = p.username || clientPresence.username || null;

    // ensure we only do one row per user_id (map keys are user_ids)
    const prev = map.get(userId);
    const prevScore = prev ? (prev.score || 0) : 0;
    const newScore = prevScore + 1;

    const obj = {
      id: userId.toString(),
      score: newScore,
      updated_at: now
    };
    // include username if available (host authored), OK to add
    if (username) obj.username = username;

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

// Request host to ensure a single leaderboard row exists for this user on page load.
// This avoids non-host clients creating rows; host authors them instead.
async function ensureMyRowExists() {
  try {
    // refresh creator if missing
    if (!creator) {
      try {
        const c = await window.websim.getCreator();
        if (c) creator = c;
      } catch (e) {
        // ignore
      }
    }

    // If currentUser is the creator (host) then we can create our own row locally (we are the author)
    if (isHostClient) {
      // Host ensures their own row exists
      const lb = room.collection("leaderboard");
      let existing = [];
      try {
        existing = await lb.filter({ id: currentUser.id }).getList();
      } catch (err) {
        const all = await lb.getList();
        existing = all.filter(r => r.id === currentUser.id);
      }
      if (!existing || existing.length === 0) {
        await lb.upsert({ id: currentUser.id, score: 0, username: currentUser.username, updated_at: new Date().toISOString() });
      }
      return;
    }

    // If not host: find creator's client id (the connected peer entry for the creator)
    const peersList = room.peers || {};
    const creatorEntry = Object.entries(peersList).find(([clientId, p]) => p.username === creator?.username || p.id === creator?.id);
    if (creatorEntry) {
      const creatorClientId = creatorEntry[0];
      // Send a presence-update request to the creator asking them to ensure our row exists.
      room.requestPresenceUpdate(creatorClientId, {
        type: "ensure_row",
        user_id: currentUser.id,
        username: currentUser.username
      });
      // Inform user: the host will create the row and the realtime subscription will update the UI when that happens.
      els.info.textContent = "Requested host to ensure your leaderboard row exists.";
    } else {
      // Creator not connected. Inform the user; their row will be created when host connects.
      els.info.textContent = "Host not connected. Your leaderboard row will be created when the host connects.";
    }
  } catch (err) {
    console.error("Error requesting host to ensure row:", err);
  }
}

// Fetch fresh leaderboard snapshot and render (used on reconnect to ensure we continue from latest scores)
async function refreshLeaderboardSnapshot() {
  try {
    const lb = room.collection("leaderboard");
    const snapshot = await lb.getList();
    // render the exact snapshot immediately to avoid any stale UI while subscription catches up
    renderLeaderboard(snapshot);
    els.info.textContent = "Leaderboard snapshot refreshed.";
  } catch (err) {
    console.error("Error refreshing leaderboard snapshot:", err);
  }
}

// initialize app
init().catch(err => {
  console.error("Failed to initialize:", err);
  document.getElementById("info").textContent = "Initialization error (see console).";
});