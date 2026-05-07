/**
 * RoboDelivery Control Center — script.js
 * Socket.IO client, UI logic, Chart.js, Toasts
 */

// ═══════════════════════════════════════════
//  Socket Setup
// ═══════════════════════════════════════════
const socket = io();

// ═══════════════════════════════════════════
//  State
// ═══════════════════════════════════════════
let deliveryCounts = { "Table 1": 0, "Table 2": 0, "Table 3": 0 };
let historyRows    = 0;
let progressTimer  = null;
let progressStart  = null;
const DELIVERY_TOTAL_MS = 7000; // must match backend timing (4+1+2)

// ═══════════════════════════════════════════
//  Chart.js Setup
// ═══════════════════════════════════════════
const ctx = document.getElementById("deliveryChart").getContext("2d");

const chartData = {
  labels: ["Table 1", "Table 2", "Table 3"],
  datasets: [{
    label: "Deliveries",
    data: [0, 0, 0],
    backgroundColor: [
      "rgba(0, 229, 255, 0.25)",
      "rgba(255, 107, 53, 0.25)",
      "rgba(168, 85, 247, 0.25)"
    ],
    borderColor: [
      "rgba(0, 229, 255, 0.9)",
      "rgba(255, 107, 53, 0.9)",
      "rgba(168, 85, 247, 0.9)"
    ],
    borderWidth: 2,
    borderRadius: 8,
    borderSkipped: false,
  }]
};

const deliveryChart = new Chart(ctx, {
  type: "bar",
  data: chartData,
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 600, easing: "easeOutQuart" },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(8,14,36,0.95)",
        borderColor: "rgba(0,229,255,0.2)",
        borderWidth: 1,
        titleColor: "#f0f4ff",
        bodyColor: "#8892aa",
        padding: 10,
        cornerRadius: 8,
        callbacks: {
          label: ctx => ` ${ctx.parsed.y} deliveries`
        }
      }
    },
    scales: {
      x: {
        grid: { color: "rgba(255,255,255,0.04)" },
        ticks: { color: "#8892aa", font: { family: "'DM Sans', sans-serif", size: 11 } },
        border: { color: "rgba(255,255,255,0.06)" }
      },
      y: {
        beginAtZero: true,
        ticks: {
          stepSize: 1,
          color: "#8892aa",
          font: { family: "'DM Sans', sans-serif", size: 11 },
          callback: v => Number.isInteger(v) ? v : ""
        },
        grid: { color: "rgba(255,255,255,0.04)" },
        border: { color: "rgba(255,255,255,0.06)" }
      }
    }
  }
});

function updateChart() {
  deliveryChart.data.datasets[0].data = [
    deliveryCounts["Table 1"],
    deliveryCounts["Table 2"],
    deliveryCounts["Table 3"]
  ];
  deliveryChart.update();
}

// ═══════════════════════════════════════════
//  Toast Notifications
// ═══════════════════════════════════════════
const toastIcons = {
  success: "fa-circle-check",
  error:   "fa-circle-xmark",
  info:    "fa-circle-info",
  warning: "fa-triangle-exclamation"
};

function showToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fas ${toastIcons[type]} toast-icon"></i>
    <span>${message}</span>
  `;
  container.appendChild(toast);

  // Play audio cue (Web Audio API — no files needed)
  if (type === "success") playBeep(880, 0.08, 0.15);
  if (type === "error")   playBeep(220, 0.1, 0.25);
  if (type === "info")    playBeep(660, 0.05, 0.1);

  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ═══════════════════════════════════════════
//  Web Audio Beep
// ═══════════════════════════════════════════
let audioCtx = null;

function playBeep(freq, vol, dur) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch (e) { /* audio not available */ }
}

// ═══════════════════════════════════════════
//  Status UI
// ═══════════════════════════════════════════
const statusTextMap = {
  idle:       "Idle",
  delivering: "Delivering",
  returning:  "Returning",
  arrived:    "Arrived!"
};

const statusDetailMap = {
  idle:       "Robot is ready for deployment",
  delivering: "En route to destination…",
  returning:  "Returning to base station…",
  arrived:    "Delivery successful!"
};

function setStatus(status, targetLabel = "") {
  const badge  = document.getElementById("statusBadge");
  const text   = document.getElementById("statusText");
  const detail = document.getElementById("statusDetail");
  const robot  = document.getElementById("robotBody");
  const trail  = document.getElementById("robotTrail");

  // Badge
  badge.className = `status-badge ${status}`;
  text.textContent = statusTextMap[status] || status;

  // Detail
  const detailMsg = targetLabel
    ? `${statusDetailMap[status]} ${targetLabel}`
    : statusDetailMap[status];
  detail.textContent = detailMsg;

  // Robot animation
  robot.className = `robot-body ${status}`;

  // Trail visibility
  if (status === "delivering" || status === "returning") {
    trail.classList.add("active");
  } else {
    trail.classList.remove("active");
  }
}

// ═══════════════════════════════════════════
//  Progress Bar
// ═══════════════════════════════════════════
function startProgress(label) {
  const wrap  = document.getElementById("deliveryProgress");
  const fill  = document.getElementById("progressFill");
  const pct   = document.getElementById("progressPct");
  const lbl   = document.getElementById("progressLabel");

  wrap.style.display = "block";
  fill.style.width = "0%";
  pct.textContent = "0%";
  lbl.textContent = label;
  progressStart = Date.now();

  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const elapsed = Date.now() - progressStart;
    const progress = Math.min((elapsed / DELIVERY_TOTAL_MS) * 100, 98);
    fill.style.width = progress + "%";
    pct.textContent  = Math.round(progress) + "%";
  }, 80);
}

function completeProgress() {
  clearInterval(progressTimer);
  const fill = document.getElementById("progressFill");
  const pct  = document.getElementById("progressPct");
  fill.style.width = "100%";
  pct.textContent  = "100%";
  setTimeout(() => {
    document.getElementById("deliveryProgress").style.display = "none";
    fill.style.width = "0%";
  }, 1200);
}

// ═══════════════════════════════════════════
//  Buttons
// ═══════════════════════════════════════════
function setButtonsDisabled(disabled) {
  document.querySelectorAll(".dispatch-btn").forEach(btn => {
    btn.disabled = disabled;
  });
}

function addRipple(btn) {
  const rect   = btn.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.cssText = `
    width: 200px; height: 200px;
    left: ${rect.width / 2 - 100}px;
    top: ${rect.height / 2 - 100}px;
  `;
  btn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
}

// ═══════════════════════════════════════════
//  History Table
// ═══════════════════════════════════════════
const tableClasses = { "Table 1": "t1", "Table 2": "t2", "Table 3": "t3" };
const tableIcons   = { "Table 1": "fa-utensils", "Table 2": "fa-chair", "Table 3": "fa-concierge-bell" };

function addHistoryRow(entry, prepend = true) {
  const emptyRow = document.getElementById("emptyRow");
  if (emptyRow) emptyRow.remove();

  historyRows++;
  const tbody = document.getElementById("historyBody");
  const cls   = tableClasses[entry.table] || "t1";
  const icon  = tableIcons[entry.table] || "fa-robot";

  const tr = document.createElement("tr");
  tr.className = "new-row";
  tr.innerHTML = `
    <td><span class="row-num">${historyRows}</span></td>
    <td>
      <span class="table-chip ${cls}">
        <i class="fas ${icon}"></i> ${entry.table}
      </span>
    </td>
    <td style="color:var(--text-secondary);font-size:0.78rem">${entry.timestamp}</td>
    <td style="color:var(--text-secondary);font-size:0.78rem">${entry.duration}</td>
    <td>
      <span class="status-pill completed">
        <i class="fas fa-check"></i> ${entry.status}
      </span>
    </td>
  `;

  if (prepend && tbody.firstChild) {
    tbody.insertBefore(tr, tbody.firstChild);
  } else {
    tbody.appendChild(tr);
  }
}

function populateHistory(historyArr) {
  const tbody = document.getElementById("historyBody");
  tbody.innerHTML = "";
  historyRows = 0;

  if (!historyArr || historyArr.length === 0) {
    tbody.innerHTML = `
      <tr id="emptyRow">
        <td colspan="5">
          <div class="empty-state">
            <i class="fas fa-robot"></i>
            <span>No deliveries yet — dispatch the robot!</span>
          </div>
        </td>
      </tr>`;
    return;
  }

  // History comes newest-first from server
  [...historyArr].reverse().forEach(entry => addHistoryRow(entry, false));
}

// ═══════════════════════════════════════════
//  Counts
// ═══════════════════════════════════════════
function updateCounts(counts) {
  deliveryCounts = counts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  document.getElementById("count-t1").textContent = counts["Table 1"] || 0;
  document.getElementById("count-t2").textContent = counts["Table 2"] || 0;
  document.getElementById("count-t3").textContent = counts["Table 3"] || 0;
  document.getElementById("totalDeliveries").textContent = total;
  document.getElementById("todayDeliveries").textContent = total;
  updateChart();
}

// ═══════════════════════════════════════════
//  Dispatch (called by buttons)
// ═══════════════════════════════════════════
function sendRobot(table) {
  const btn = document.querySelector(`.dispatch-btn[data-table="${table}"]`);
  if (btn) addRipple(btn);

  socket.emit("send_robot", { table });
  showToast(`Dispatching robot to ${table}…`, "info");
}

// ═══════════════════════════════════════════
//  Clear History
// ═══════════════════════════════════════════
function clearHistory() {
  fetch("/api/clear_history", { method: "POST" })
    .then(r => r.json())
    .then(() => showToast("History cleared.", "warning"))
    .catch(() => showToast("Failed to clear history.", "error"));
}

// ═══════════════════════════════════════════
//  Dark / Light Mode
// ═══════════════════════════════════════════
const themeToggle = document.getElementById("themeToggle");
const themeIcon   = document.getElementById("themeIcon");

themeToggle.addEventListener("click", () => {
  const html  = document.documentElement;
  const isLight = html.getAttribute("data-theme") === "light";
  html.setAttribute("data-theme", isLight ? "dark" : "light");
  themeIcon.className = isLight ? "fas fa-moon" : "fas fa-sun";
  updateChartTheme(isLight ? "dark" : "light");
});

function updateChartTheme(theme) {
  const gridColor = theme === "dark" ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)";
  const tickColor = theme === "dark" ? "#8892aa" : "#64748b";
  deliveryChart.options.scales.x.grid.color = gridColor;
  deliveryChart.options.scales.y.grid.color = gridColor;
  deliveryChart.options.scales.x.ticks.color = tickColor;
  deliveryChart.options.scales.y.ticks.color = tickColor;
  deliveryChart.update();
}

// ═══════════════════════════════════════════
//  Socket Events
// ═══════════════════════════════════════════

socket.on("connect", () => {
  const badge = document.getElementById("connectionBadge");
  badge.className = "connection-badge connected";
  document.getElementById("connLabel").textContent = "Connected";
  showToast("Connected to robot server.", "success", 2500);
});

socket.on("disconnect", () => {
  const badge = document.getElementById("connectionBadge");
  badge.className = "connection-badge disconnected";
  document.getElementById("connLabel").textContent = "Disconnected";
  showToast("Connection lost. Reconnecting…", "error", 5000);
});

socket.on("init_state", (data) => {
  updateCounts(data.counts);
  populateHistory(data.history);
  setStatus(data.status, data.current_target || "");

  if (data.status !== "idle") {
    setButtonsDisabled(true);
    startProgress("Resuming delivery…");
  }
});

socket.on("status_update", (data) => {
  setStatus(data.status, data.target || "");

  if (data.status === "delivering") {
    setButtonsDisabled(true);
    startProgress(`To ${data.target}…`);
    showToast(data.message, "info");
    playBeep(440, 0.08, 0.2);
  } else if (data.status === "arrived") {
    showToast(data.message, "success");
    playBeep(880, 0.08, 0.15);
  } else if (data.status === "returning") {
    showToast(data.message, "info");
  } else if (data.status === "idle") {
    setButtonsDisabled(false);
    showToast(data.message, "success");
  }
});

socket.on("delivery_complete", (data) => {
  completeProgress();
  updateCounts(data.counts);
  addHistoryRow(data.entry, true);
  showToast(data.message, "success");
  playBeep(523, 0.1, 0.3);
});

socket.on("history_cleared", (data) => {
  updateCounts(data.counts);
  populateHistory([]);
  historyRows = 0;
});

socket.on("error", (data) => {
  showToast(data.message, "error");
  playBeep(220, 0.1, 0.3);
});
