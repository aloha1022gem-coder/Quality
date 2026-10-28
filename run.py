"""启动 SQM Insight：python run.py [--port 8765] [--reset] [--no-browser]"""
import argparse
import sys
import threading
import webbrowser

from sqm.db import Database
from sqm.field.db import FieldDatabase
from sqm.field.seed import seed as seed_field
from sqm.seed import seed
from sqm.server import App, serve


def main():
    p = argparse.ArgumentParser(description="SQM Insight · AI 供应商质量管理演示系统")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--reset", action="store_true", help="清空数据库并重新生成演示数据")
    p.add_argument("--no-browser", action="store_true")
    args = p.parse_args()

    db = Database()
    if args.reset or db.is_empty():
        info = seed(db)
        print(f"已生成演示数据：{info['lots']} 个 IQC 批次，{info['kb_docs']} 份知识库文件")
    field_db = FieldDatabase()
    if args.reset or field_db.is_empty():
        info = seed_field(field_db)
        print(f"已生成售后故障演示数据：{info['batches']} 个生产批次，{info['failures']} 条报修记录")
    app = App(db, field_db)
    try:
        httpd = serve(app, args.host, args.port)
    except OSError:
        print(f"端口 {args.port} 被占用，请使用 --port 指定其他端口")
        sys.exit(1)
    url = f"http://{args.host}:{args.port}/"
    print(f"SQM Insight 已启动：{url}  （按 Ctrl+C 停止）")
    print(f"售后故障追踪：{url}field")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
