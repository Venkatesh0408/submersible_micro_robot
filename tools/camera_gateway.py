#!/usr/bin/env python3
"""VSTY camera gateway: pull ESP32-CAM MJPEG locally and relay JPEG frames to Render."""

import argparse
import os
import socket
import sys
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
    parser = argparse.ArgumentParser(description="Relay ESP32-CAM MJPEG to the VSTY Render dashboard.")
    parser.add_argument("--camera-url", default=DEFAULT_CAMERA, help="Local ESP32-CAM MJPEG URL")
    parser.add_argument("--server-url", default=DEFAULT_SERVER, help="VSTY Render server base URL")
    parser.add_argument("--token", default=None, help="VSTY operator authentication token (or set VSTY_AUTH_TOKEN)")
    parser.add_argument("--fps", type=float, default=30.0, help="Maximum upload frame rate (default: 30; server safety ceiling: 60)")
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


def upload_frame_urllib(upload_url, frame, token, timeout=10):
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
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "ignore")


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
    sent = 0
    last_upload = 0.0
    last_report = time.monotonic()
    report_count = 0

    local_ip = get_local_ip()
    cam_host = parsed.hostname or ""

    print("=" * 60)
    print("VSTY Camera Gateway (Laptop -> Render Cloud)")
    print("=" * 60)
    print("Laptop IP: " + local_ip)
    print("Camera   : " + args.camera_url)
    print("Render   : " + server)
    print("Limit    : " + str(args.fps) + " FPS (server ceiling: 60)")
    if not HAVE_REQUESTS:
        print("Engine   : Python standard library (urllib)")
    else:
        print("Engine   : requests (keep-alive session)")
    print("Press Ctrl+C to stop.\n")

    if cam_host and cam_host not in ("127.0.0.1", "localhost"):
        cam_prefix = ".".join(cam_host.split(".")[:3])
        local_prefix = ".".join(local_ip.split(".")[:3])
        if cam_prefix != local_prefix:
            print("=" * 60)
            print("[!] WARNING: Wi-Fi Subnet Mismatch Detected!")
            print("    Your laptop IP is : " + local_ip)
            print("    Your camera IP is : " + cam_host)
            print("    Your laptop and ESP32 are on DIFFERENT Wi-Fi networks.")
            print("    -> Connect your laptop's Wi-Fi to your phone hotspot ('GalaxyA14').")
            print("=" * 60 + "\n")

    session = requests.Session() if HAVE_REQUESTS else None
    if session:
        session.headers.update({"Accept": "*/*", "Connection": "keep-alive"})

    while True:
        try:
            print("Connecting to ESP32-CAM stream...")
            if HAVE_REQUESTS:
                with session.get(args.camera_url, stream=True, timeout=(5, 20)) as camera:
                    camera.raise_for_status()
                    content_type = camera.headers.get("Content-Type", "")
                    if "multipart" not in content_type.lower() and "image" not in content_type.lower():
                        raise RuntimeError("Unexpected camera content type: " + content_type)
                    print("Camera connected. Relaying JPEG frames to Render...")
                    for frame in extract_frames(camera.iter_content(chunk_size=8192), args.max_frame_bytes):
                        now = time.monotonic()
                        wait = frame_interval - (now - last_upload)
                        if wait > 0:
                            time.sleep(wait)
                        try:
                            result = session.post(
                                upload_url,
                                data=frame,
                                headers={
                                    "Authorization": "Bearer " + token,
                                    "Content-Type": "image/jpeg",
                                    "Accept": "application/json",
                                },
                                timeout=(5, 10),
                            )
                            status_code = result.status_code
                            text = result.text
                        except requests.RequestException as exc:
                            print("Render upload failed: " + str(exc))
                            break

                        if status_code == 401:
                            print("ERROR: Render rejected the login token (HTTP 401). Sign in again and refresh the token.")
                            return 3
                        if status_code == 403:
                            print("ERROR: This login does not have operator/admin access to the camera relay.")
                            return 3
                        if status_code == 429:
                            time.sleep(0.01)
                            continue
                        if status_code == 413:
                            print("ERROR: Frame too large. Lower ESP32-CAM resolution or increase JPEG compression.")
                            return 4
                        if status_code != 202:
                            print("Render rejected frame: HTTP " + str(status_code) + " " + text[:180])
                            if status_code >= 500:
                                break
                            time.sleep(1)
                            continue

                        last_upload = time.monotonic()
                        sent += 1
                        report_count += 1
                        if last_upload - last_report >= 2:
                            measured = report_count / (last_upload - last_report)
                            print("Relaying: " + str(round(measured, 1)) + " FPS | frame " + str(len(frame)) + " bytes")
                            last_report = last_upload
                            report_count = 0
            else:
                # Built-in urllib fallback (works without requests library)
                camera = open_urllib_stream(args.camera_url, timeout=10)
                print("Camera connected. Relaying JPEG frames to Render...")
                stream_iter = iter_camera_chunks(camera)
                for frame in extract_frames(stream_iter, args.max_frame_bytes):
                    now = time.monotonic()
                    wait = frame_interval - (now - last_upload)
                    if wait > 0:
                        time.sleep(wait)
                    try:
                        status_code, text = upload_frame_urllib(upload_url, frame, token, timeout=10)
                    except Exception as exc:
                        print("Render upload failed: " + str(exc))
                        break

                    if status_code == 401:
                        print("ERROR: Render rejected the login token (HTTP 401). Sign in again and refresh the token.")
                        return 3
                    if status_code == 403:
                        print("ERROR: This login does not have operator/admin access to the camera relay.")
                        return 3
                    if status_code == 429:
                        time.sleep(0.01)
                        continue
                    if status_code == 413:
                        print("ERROR: Frame too large. Lower ESP32-CAM resolution or increase JPEG compression.")
                        return 4
                    if status_code != 202:
                        print("Render rejected frame: HTTP " + str(status_code) + " " + text[:180])
                        if status_code >= 500:
                            break
                        time.sleep(1)
                        continue

                    last_upload = time.monotonic()
                    sent += 1
                    report_count += 1
                    if last_upload - last_report >= 2:
                        measured = report_count / (last_upload - last_report)
                        print("Relaying: " + str(round(measured, 1)) + " FPS | frame " + str(len(frame)) + " bytes")
                        last_report = last_upload
                        report_count = 0

            print("Camera stream ended. Reconnecting in 2 seconds...")
        except KeyboardInterrupt:
            print("\nGateway stopped. Total frames relayed: " + str(sent))
            return 0
        except Exception as exc:
            print("Connection error: " + str(exc))
            err_str = str(exc).lower()
            if "10051" in err_str or "unreachable" in err_str:
                print("-> Hint: Network unreachable. Make sure your laptop and ESP32 are connected to the same Wi-Fi.")
            elif "timed out" in err_str:
                print("-> Hint: Stream timed out. Ensure the ESP32 is powered on and close any browser tabs viewing " + args.camera_url)
        time.sleep(2)


if __name__ == "__main__":
    sys.exit(main())
