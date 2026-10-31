#!/usr/bin/env python3
"""VSTY camera gateway: pull ESP32-CAM MJPEG locally and relay JPEG frames to Render."""

import argparse
import os
import sys
import time
from urllib.parse import urlparse

import requests

DEFAULT_SERVER = "https://submersible-micro-robot.onrender.com"
DEFAULT_CAMERA = "http://192.168.4.10:81/stream"
MAX_FRAME_BYTES = 512 * 1024


def parse_args():
    parser = argparse.ArgumentParser(description="Relay ESP32-CAM MJPEG to the VSTY Render dashboard.")
    parser.add_argument("--camera-url", default=DEFAULT_CAMERA, help="Local ESP32-CAM MJPEG URL")
    parser.add_argument("--server-url", default=DEFAULT_SERVER, help="VSTY Render server base URL")
    parser.add_argument("--fps", type=float, default=40.0, help="Maximum upload frame rate (default: 40; server safety ceiling: 40)")
    parser.add_argument("--max-frame-bytes", type=int, default=MAX_FRAME_BYTES)
    return parser.parse_args()


def extract_frames(response, max_frame_bytes):
    pending = bytearray()
    for chunk in response.iter_content(chunk_size=8192):
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


def main():
    args = parse_args()
    token = os.environ.get("VSTY_AUTH_TOKEN", "").strip()
    if not token:
        print("ERROR: Set VSTY_AUTH_TOKEN to your VSTY software login token first.")
        print("Do not share this token or commit it to GitHub.")
        return 2
    if args.fps <= 0 or args.fps > 40:
        print("ERROR: --fps must be greater than 0 and no more than 40.")
        return 2
    parsed = urlparse(args.camera_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        print("ERROR: --camera-url must be a valid http:// or https:// URL.")
        return 2

    server = args.server_url.rstrip("/")
    upload_url = server + "/api/camera/relay/frame"
    session = requests.Session()
    # Never send the Render login token to the local ESP32-CAM.
    session.headers.update({
        "Accept": "*/*",
        "Connection": "keep-alive",
    })
    frame_interval = 1.0 / args.fps
    sent = 0
    last_upload = 0.0
    last_report = time.monotonic()
    report_count = 0

    print("VSTY Camera Gateway")
    print("Camera : " + args.camera_url)
    print("Render : " + server)
    print("Limit  : " + str(args.fps) + " FPS (server ceiling: 40)")
    print("Press Ctrl+C to stop.\n")

    while True:
        try:
            print("Connecting to ESP32-CAM stream...")
            with session.get(args.camera_url, stream=True, timeout=(5, 20)) as camera:
                camera.raise_for_status()
                content_type = camera.headers.get("Content-Type", "")
                if "multipart" not in content_type.lower() and "image" not in content_type.lower():
                    raise RuntimeError("Unexpected camera content type: " + content_type)
                print("Camera connected. Relaying JPEG frames to Render...")
                for frame in extract_frames(camera, args.max_frame_bytes):
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
                    except requests.RequestException as exc:
                        print("Render upload failed: " + str(exc))
                        break
                    if result.status_code == 401:
                        print("ERROR: Render rejected the login token (HTTP 401). Sign in again and refresh the token.")
                        return 3
                    if result.status_code == 403:
                        print("ERROR: This login does not have operator/admin access to the camera relay.")
                        return 3
                    if result.status_code == 429:
                        # Drop this frame and keep the stream moving; never build a backlog.
                        time.sleep(0.01)
                        continue
                    if result.status_code == 413:
                        print("ERROR: Frame too large. Lower ESP32-CAM resolution or increase JPEG compression.")
                        return 4
                    if result.status_code != 202:
                        print("Render rejected frame: HTTP " + str(result.status_code) + " " + result.text[:180])
                        if result.status_code >= 500:
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
        except requests.RequestException as exc:
            print("Connection error: " + str(exc))
        except Exception as exc:
            print("Gateway error: " + str(exc))
        time.sleep(2)


if __name__ == "__main__":
    sys.exit(main())
