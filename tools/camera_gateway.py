#!/usr/bin/env python3
"""VSTY high-performance camera gateway: pull ESP32-CAM or phone IP webcam MJPEG locally and relay JPEG frames to Render with multi-threaded pipelining."""

import argparse
import os
import queue
import socket
import sys
import threading
import time
from urllib.parse import urlparse

try:
    import requests
    HAVE_REQUESTS = True
except ImportError:
    import urllib.request
    import urllib.error
    HAVE_REQUESTS = False

DEFAULT_SERVER = "https://submersible-micro-robot.onrender.com"
DEFAULT_CAMERA = "http://192.168.4.1:81/stream"
MAX_FRAME_BYTES = 512 * 1024


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def parse_args():
    parser = argparse.ArgumentParser(description="Relay ESP32-CAM or Phone MJPEG to the VSTY Render dashboard at high FPS.")
    parser.add_argument("--camera-url", default=DEFAULT_CAMERA, help="Local ESP32-CAM / Phone MJPEG URL (e.g. http://10.31.142.33:8080/video)")
    parser.add_argument("--server-url", default=DEFAULT_SERVER, help="VSTY Render server base URL")
    parser.add_argument("--token", default=None, help="VSTY operator authentication token (or set VSTY_AUTH_TOKEN)")
    parser.add_argument("--fps", type=float, default=60.0, help="Target upload frame rate (default: 60; server safety ceiling: 60)")
    parser.add_argument("--workers", type=int, default=8, help="Number of parallel upload workers to defeat network latency (default: 8)")
    parser.add_argument("--max-frame-bytes", type=int, default=MAX_FRAME_BYTES)
    return parser.parse_args()


def extract_frames(stream_iterator, max_frame_bytes):
    pending = bytearray()
    for chunk in stream_iterator:
        if not chunk:
            continue
        pending.extend(chunk)
        while True:
            start = pending.find(b"\xff\xd8")
            if start < 0:
                if len(pending) > 1:
                    del pending[:-1]
                break
            if start:
                del pending[:start]
            end = pending.find(b"\xff\xd9", 2)
            if end < 0:
                if len(pending) > max_frame_bytes:
                    pending.clear()
                break
            frame = bytes(pending[: end + 2])
            del pending[: end + 2]
            if len(frame) <= max_frame_bytes:
                yield frame


def open_urllib_stream(camera_url, timeout=10):
    req = urllib.request.Request(camera_url, headers={"Accept": "*/*", "Connection": "keep-alive"})
    camera = urllib.request.urlopen(req, timeout=timeout)
    content_type = camera.headers.get("Content-Type", "")
    if "multipart" not in content_type.lower() and "image" not in content_type.lower():
        camera.close()
        raise RuntimeError("Unexpected camera content type: " + content_type)
    return camera


def iter_camera_chunks(camera):
    try:
        while True:
            chunk = camera.read(8192)
            if not chunk:
                break
            yield chunk
    finally:
        try:
            camera.close()
        except Exception:
            pass


def upload_worker(worker_id, upload_url, token, frame_queue, stats, stop_event):
    """Worker thread that continuously uploads frames to Render using persistent HTTP Keep-Alive."""
    if HAVE_REQUESTS:
        session = requests.Session()
        session.headers.update({
            "Authorization": "Bearer " + token,
            "Content-Type": "image/jpeg",
            "Accept": "application/json",
            "Connection": "keep-alive",
        })
    else:
        session = None

    while not stop_event.is_set():
        try:
            frame = frame_queue.get(timeout=0.2)
        except queue.Empty:
            continue

        try:
            if HAVE_REQUESTS:
                resp = session.post(upload_url, data=frame, timeout=(3, 5))
                status = resp.status_code
            else:
                req = urllib.request.Request(
                    upload_url,
                    data=frame,
                    headers={
                        "Authorization": "Bearer " + token,
                        "Content-Type": "image/jpeg",
                        "Accept": "application/json",
                    },
                    method="POST"
                )
                try:
                    with urllib.request.urlopen(req, timeout=5) as r:
                        status = r.status
                except urllib.error.HTTPError as err:
                    status = err.code

            if status == 202:
                with stats["lock"]:
                    stats["sent"] += 1
                    stats["bytes"] += len(frame)
                    stats["recent_sent"] += 1
                    stats["recent_bytes"] += len(frame)
            elif status == 429:
                time.sleep(0.01)
        except Exception:
            pass
        finally:
            frame_queue.task_done()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(line_buffering=True)
        except Exception:
            pass

    args = parse_args()
    token = (args.token or os.environ.get("VSTY_AUTH_TOKEN", "")).strip()
    if not token:
        print("ERROR: Set VSTY_AUTH_TOKEN or pass --token <your_token>.")
        print("Tip: Click 'Copy Gateway Token' on your Render dashboard to get it.")
        return 2

    if args.fps <= 0 or args.fps > 60:
        print("ERROR: --fps must be greater than 0 and no more than 60.")
        return 2

    parsed = urlparse(args.camera_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        print("ERROR: --camera-url must be a valid http:// or https:// URL.")
        return 2

    server = args.server_url.rstrip("/")
    upload_url = server + "/api/camera/relay/frame"
    frame_interval = 1.0 / args.fps

    local_ip = get_local_ip()
    cam_host = parsed.hostname or ""

    print("=" * 65)
    print("      VSTY High-Speed Camera Gateway (Laptop -> Render Cloud)     ")
    print("=" * 65)
    print("Laptop IP  : " + local_ip)
    print("Camera URL : " + args.camera_url)
    print("Render URL : " + server)
    print("Target FPS : " + str(args.fps) + " FPS (server ceiling: 60)")
    print("Workers    : " + str(args.workers) + " parallel upload threads (anti-latency pipeline)")
    if HAVE_REQUESTS:
        print("Engine     : requests (high-performance keep-alive connection pool)")
    else:
        print("Engine     : Python standard library (urllib)")
    print("Press Ctrl+C to stop.\n")

    if cam_host and cam_host not in ("127.0.0.1", "localhost"):
        cam_prefix = ".".join(cam_host.split(".")[:3])
        local_prefix = ".".join(local_ip.split(".")[:3])
        if cam_prefix != local_prefix and not cam_host.startswith("192.168.4."):
            print("=" * 65)
            print("[!] WARNING: Wi-Fi Subnet Mismatch Detected!")
            print("    Laptop IP : " + local_ip)
            print("    Camera IP : " + cam_host)
            print("    Ensure your laptop and phone/ESP32 are on the same Wi-Fi / hotspot.")
            print("=" * 65 + "\n")

    # Shared thread-safe queue and statistics
    frame_queue = queue.Queue(maxsize=12)
    stats = {
        "lock": threading.Lock(),
        "sent": 0,
        "bytes": 0,
        "recent_sent": 0,
        "recent_bytes": 0,
    }
    stop_event = threading.Event()

    # Launch worker threads
    workers = []
    for wid in range(args.workers):
        t = threading.Thread(
            target=upload_worker,
            args=(wid, upload_url, token, frame_queue, stats, stop_event),
            daemon=True
        )
        t.start()
        workers.append(t)

    session = requests.Session() if HAVE_REQUESTS else None
    if session:
        session.headers.update({"Accept": "*/*", "Connection": "keep-alive"})

    while True:
        try:
            print("Connecting to camera stream: " + args.camera_url + " ...")
            if HAVE_REQUESTS:
                with session.get(args.camera_url, stream=True, timeout=(5, 20)) as camera:
                    camera.raise_for_status()
                    content_type = camera.headers.get("Content-Type", "")
                    if "multipart" not in content_type.lower() and "image" not in content_type.lower():
                        raise RuntimeError("Unexpected camera content type: " + content_type)
                    print("Camera connected! Streaming at high FPS to Render...")

                    last_upload = 0.0
                    last_report = time.monotonic()
                    stream_iter = camera.iter_content(chunk_size=8192)

                    for frame in extract_frames(stream_iter, args.max_frame_bytes):
                        now = time.monotonic()
                        wait = frame_interval - (now - last_upload)
                        if wait > 0:
                            time.sleep(wait)
                        last_upload = time.monotonic()

                        # Put frame into queue; if queue is full, discard oldest frame to eliminate latency
                        try:
                            frame_queue.put_nowait(frame)
                        except queue.Full:
                            try:
                                frame_queue.get_nowait()
                                frame_queue.task_done()
                            except queue.Empty:
                                pass
                            try:
                                frame_queue.put_nowait(frame)
                            except queue.Full:
                                pass

                        # Stats reporter (every 1.5 seconds)
                        if now - last_report >= 1.5:
                            elapsed = now - last_report
                            with stats["lock"]:
                                r_sent = stats["recent_sent"]
                                r_bytes = stats["recent_bytes"]
                                stats["recent_sent"] = 0
                                stats["recent_bytes"] = 0
                            fps_meas = r_sent / elapsed if elapsed > 0 else 0
                            avg_kb = (r_bytes / r_sent / 1024) if r_sent > 0 else 0
                            print(f"Relaying: {fps_meas:4.1f} FPS | avg frame: {avg_kb:5.1f} KB | queue: {frame_queue.qsize()}")
                            last_report = now
            else:
                camera = open_urllib_stream(args.camera_url, timeout=10)
                print("Camera connected! Streaming at high FPS to Render...")
                stream_iter = iter_camera_chunks(camera)
                last_upload = 0.0
                last_report = time.monotonic()

                for frame in extract_frames(stream_iter, args.max_frame_bytes):
                    now = time.monotonic()
                    wait = frame_interval - (now - last_upload)
                    if wait > 0:
                        time.sleep(wait)
                    last_upload = time.monotonic()

                    try:
                        frame_queue.put_nowait(frame)
                    except queue.Full:
                        try:
                            frame_queue.get_nowait()
                            frame_queue.task_done()
                        except queue.Empty:
                            pass
                        try:
                            frame_queue.put_nowait(frame)
                        except queue.Full:
                            pass

                    if now - last_report >= 1.5:
                        elapsed = now - last_report
                        with stats["lock"]:
                            r_sent = stats["recent_sent"]
                            r_bytes = stats["recent_bytes"]
                            stats["recent_sent"] = 0
                            stats["recent_bytes"] = 0
                        fps_meas = r_sent / elapsed if elapsed > 0 else 0
                        avg_kb = (r_bytes / r_sent / 1024) if r_sent > 0 else 0
                        print(f"Relaying: {fps_meas:4.1f} FPS | avg frame: {avg_kb:5.1f} KB | queue: {frame_queue.qsize()}")
                        last_report = now

            print("Camera stream ended. Reconnecting in 2 seconds...")
        except KeyboardInterrupt:
            stop_event.set()
            with stats["lock"]:
                total = stats["sent"]
            print(f"\nGateway stopped. Total frames relayed: {total}")
            return 0
        except Exception as exc:
            print("Connection error: " + str(exc))
            err_str = str(exc).lower()
            if "10061" in err_str:
                print("-> Hint: Phone camera server is stopped or asleep. Re-open IP Webcam and tap 'Start server'.")
            elif "10051" in err_str or "unreachable" in err_str:
                print("-> Hint: Network unreachable. Make sure laptop and camera are on the same Wi-Fi.")
            elif "timed out" in err_str:
                print("-> Hint: Stream timed out. Ensure the phone/ESP32 is awake and streaming.")
        time.sleep(2)


if __name__ == "__main__":
    sys.exit(main())
