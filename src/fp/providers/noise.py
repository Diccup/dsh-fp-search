"""指纹噪声。"""
from __future__ import annotations
import random


def noise_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    canvas = round(rng.uniform(0.0001, 0.02), 6)
    audio = round(rng.uniform(0.0001, 0.02), 6)
    webgl = round(rng.uniform(0.0001, 0.02), 6)
    return {
        "canvas": canvas,
        "audio": audio,
        "webgl": webgl,
        "webgl_params": {
            "UNMASKED_VENDOR": "Google Inc. (Intel)",
            "UNMASKED_RENDERER": "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)",
        },
        "enabled": True,
    }


def apply_canvas_noise(seed: int = 0) -> str:
    rng = random.Random(seed)
    amp = round(rng.uniform(0.0001, 0.02), 6)
    return (
        "(function(){const _orig=document.createElement.bind(document);"
        "document.createElement=function(tag){const el=_orig(tag);"
        "if(tag.toLowerCase()==='canvas'){const ctx=el.getContext&&el.getContext('2d');"
        "if(ctx){const d=ctx.getImageData(0,0,1,1);d.data[0]=(d.data[0]+" + str(int(amp*100000)) + ")%256;ctx.putImageData(d,0,0);}"
        "}return el;};})();"
    )
