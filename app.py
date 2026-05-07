import threading
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO, emit
from datetime import datetime
from supabase import create_client
import serial
import time

# 🔌 Serial Setup
ser = serial.Serial('COM5', 9600, timeout=1)
time.sleep(2)

# 🔐 Supabase config
SUPABASE_URL = "https://ukvbawjyfwjyxddcxtly.supabase.co"
SUPABASE_KEY = "sb_publishable_ncaVqaK0DetkjH03NoiVpQ_Nhj2B7eF"

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__)
app.config['SECRET_KEY'] = 'delivery-robot-secret-2024'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# ─────────────────────────── UID Mapping ───────────────────────────
TABLE_UID_MAP = {
    "Table 1": "3A5F2C1B",
    "Table 2": "A1B2C3D4",
    "Table 3": "9F8E7D6C"
}

# ─────────────────────────── State ───────────────────────────
robot_state = {
    "status": "idle",
    "current_target": None,
    "history": [],
    "delivery_count": {"Table 1": 0, "Table 2": 0, "Table 3": 0},
    "busy": False
}

# ─────────────────────────── Supabase Helpers ───────────────────────────
def save_delivery(entry):
    supabase.table("deliveries").insert({
        "table_name": entry["table"],
        "timestamp": entry["timestamp"],
        "status": entry["status"],
        "duration": entry["duration"]
    }).execute()

def load_history():
    response = supabase.table("deliveries").select("*").order("id", desc=True).execute()
    data = response.data or []
    return [{
        "table": item["table_name"],
        "timestamp": item["timestamp"],
        "status": item["status"],
        "duration": item["duration"]
    } for item in data]

# Load previous data
robot_state["history"] = load_history()
for item in robot_state["history"]:
    robot_state["delivery_count"][item["table"]] += 1

# ─────────────────────────── Socket Events ───────────────────────────
@socketio.on("connect")
def on_connect():
    emit("init_state", {
        "status": robot_state["status"],
        "current_target": robot_state["current_target"],
        "history": robot_state["history"],
        "counts": robot_state["delivery_count"]
    })

@socketio.on("send_robot")
def on_send_robot(data):
    table = data.get("table")

    if table not in TABLE_UID_MAP:
        emit("error", {"message": "Invalid table"})
        return

    if robot_state["busy"]:
        emit("error", {"message": "Robot is busy"})
        return

    uid = TABLE_UID_MAP[table]

    # 🔥 Send ONLY here (correct place)
    ser.write((uid + "\n").encode())

    robot_state["status"] = "delivering"
    robot_state["current_target"] = table
    robot_state["busy"] = True

    socketio.emit("status_update", {
        "status": "delivering",
        "target": table,
        "message": f"🚀 Moving to {table}"
    })

# ─────────────────────────── Handle Completion ───────────────────────────
def handle_delivery_complete(table_name):
    robot_state["status"] = "idle"
    robot_state["current_target"] = None
    robot_state["busy"] = False

    robot_state["delivery_count"][table_name] += 1

    entry = {
        "table": table_name,
        "timestamp": datetime.now().strftime("%d %b %Y, %I:%M:%S %p"),
        "status": "Completed",
        "duration": "Actual (Arduino Controlled)"
    }

    save_delivery(entry)
    robot_state["history"] = load_history()

    socketio.emit("delivery_complete", {
        "entry": entry,
        "counts": robot_state["delivery_count"],
        "message": f"📦 Delivery to {table_name} complete!"
    })

    socketio.emit("status_update", {
        "status": "idle",
        "target": None,
        "message": "🟢 Robot ready"
    })

# ─────────────────────────── Serial Listener ───────────────────────────
def read_serial():
    while True:
        if ser.in_waiting:
            line = ser.readline().decode(errors="ignore").strip()
            print("Arduino:", line)

            if line.startswith("DELIVERED:"):
                uid = line.split(":")[1]

                # Find table name
                for table, u in TABLE_UID_MAP.items():
                    if u == uid:
                        handle_delivery_complete(table)
                        break

# Start thread
threading.Thread(target=read_serial, daemon=True).start()

# ─────────────────────────── Routes ───────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/state")
def get_state():
    return jsonify(robot_state)

# ─────────────────────────── Run ───────────────────────────
if __name__ == "__main__":
    print("🤖 Server running at http://localhost:5000")
    socketio.run(app, debug=True, host="0.0.0.0", port=5000)