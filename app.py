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
try:
    ser = serial.Serial('COM5', 9600, timeout=1)
    time.sleep(2)
    print("✅ Arduino connected")
except Exception as e:
    print("❌ Arduino connection failed:", e)
    ser = None

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
    "delivery_count": {
        "Table 1": 0,
        "Table 2": 0,
        "Table 3": 0
    },
    "busy": False,
    "start_time": None
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

    # Send UID to Arduino
    if ser:
        ser.write((uid + "\n").encode())
    else:
        emit("error", {"message": "Arduino not connected"})
        return

    # Update robot state
    robot_state["status"] = "delivering"
    robot_state["current_target"] = table
    robot_state["busy"] = True
    robot_state["start_time"] = time.time()

    socketio.emit("status_update", {
        "status": "delivering",
        "target": table,
        "message": f"🚀 Moving to {table}"
    })


# ─────────────────────────── Handle Completion ───────────────────────────
def handle_delivery_complete(table_name):

    if not robot_state["busy"]:
        return

    duration = 0

    if robot_state["start_time"]:
        duration = round(time.time() - robot_state["start_time"], 1)

    robot_state["status"] = "idle"
    robot_state["current_target"] = None
    robot_state["busy"] = False
    robot_state["start_time"] = None

    robot_state["delivery_count"][table_name] += 1

    entry = {
        "table": table_name,
        "timestamp": datetime.now().strftime("%d %b %Y, %I:%M:%S %p"),
        "status": "Completed",
        "duration": f"{duration}s"
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

        if ser and ser.in_waiting:

            line = ser.readline().decode(errors="ignore").strip()

            print("Arduino:", line)

            # ───────── ARRIVED ─────────
            if line.startswith("ARRIVED:"):

                uid = line.split(":")[1]

                for table, u in TABLE_UID_MAP.items():

                    if u == uid:

                        robot_state["status"] = "arrived"

                        socketio.emit("status_update", {
                            "status": "arrived",
                            "target": table,
                            "message": f"✅ Robot arrived at {table}"
                        })

                        break

            # ───────── RETURNING ─────────
            elif line.startswith("RETURNING:"):

                uid = line.split(":")[1]

                for table, u in TABLE_UID_MAP.items():

                    if u == uid:

                        robot_state["status"] = "returning"

                        socketio.emit("status_update", {
                            "status": "returning",
                            "target": table,
                            "message": f"↩️ Returning from {table}"
                        })

                        break

            # ───────── DELIVERY COMPLETE ─────────
            elif line.startswith("DELIVERED:"):

                uid = line.split(":")[1]

                for table, u in TABLE_UID_MAP.items():

                    if u == uid:

                        handle_delivery_complete(table)

                        break

            # ───────── WRONG RFID ─────────
            elif line.startswith("WRONG_TAG:"):

                socketio.emit("error", {
                    "message": "❌ Wrong RFID detected"
                })
            elif line == "TIMEOUT":

                robot_state["status"] = "idle"
                robot_state["busy"] = False
                robot_state["current_target"] = None

                socketio.emit("error", {
                     "message": "⏰ Robot timeout — RFID not detected"
            })

            socketio.emit("status_update", {
                "status": "idle",
                "target": None,
                "message": "🟢 Robot ready"
    })
# Start thread
threading.Thread(target=read_serial, daemon=True).start()

# ─────────────────────────── Routes ───────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/state")
def get_state():
    return jsonify(robot_state)

@app.route("/api/clear_history", methods=["POST"])
def clear_history():

    # Clear Supabase table
    supabase.table("deliveries").delete().neq("id", 0).execute()

    robot_state["history"] = []
    robot_state["delivery_count"] = {
        "Table 1": 0,
        "Table 2": 0,
        "Table 3": 0
    }

    socketio.emit("history_cleared", {
        "counts": robot_state["delivery_count"]
    })

    return jsonify({"success": True})

# ─────────────────────────── Run ───────────────────────────
if __name__ == "__main__":
    print("🤖 Server running at http://localhost:5000")
    socketio.run(app, debug=True, host="0.0.0.0", port=5000)
