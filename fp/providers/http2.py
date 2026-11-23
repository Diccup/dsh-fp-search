"""HTTP/2 指纹。"""
from __future__ import annotations

def http2_profile() -> dict:
    return {
        "settings": {
            "HEADER_TABLE_SIZE": 65536,
            "ENABLE_PUSH": 0,
            "MAX_CONCURRENT_STREAMS": 1000,
            "INITIAL_WINDOW_SIZE": 6291456,
            "MAX_HEADER_LIST_SIZE": 262144,
            "MAX_FRAME_SIZE": 16384,
        },
        "header_order": [
            "accept", "accept-encoding", "accept-language", "cache-control",
            "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest",
            "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "upgrade-insecure-requests",
            "user-agent",
        ],
        "pseudo_order": [":method", ":authority", ":scheme", ":path"],
        "priority_frames": [{"stream_id": 3, "weight": 256, "exclusive": False}],
    }
