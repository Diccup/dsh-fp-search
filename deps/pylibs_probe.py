# pylibs_probe · doctor 用：验证 curl_cffi 可导入，结果写文件（沙箱 stdout 管道不可靠）
# argv[1]=pylibs 路径 argv[2]=输出 json 路径
import sys, json
sys.path.insert(0, sys.argv[1])
out = {'python': sys.version.split()[0], 'ok': False}
try:
    import curl_cffi
    out['ok'] = True
    out['curl_cffi'] = getattr(curl_cffi, '__version__', 'unknown')
except Exception as e:
    out['err'] = str(e)[:200]
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    json.dump(out, f)
