"""可选的大模型生成（默认关闭）。

启用条件（两项都满足才会调用外部 API）：
1. 已安装官方 SDK：pip install anthropic
2. 设置环境变量 ANTHROPIC_API_KEY，并设置 SQM_LLM=on 表示已获授权把检索到的内部资料发送给模型服务

未启用时，系统只使用本地检索与证据式摘要，所有数据不出本机。
"""
import os

MODEL = os.environ.get("SQM_LLM_MODEL", "claude-opus-5-5")

SYSTEM = (
    "你是工厂供应商质量工程（SQE）助手。只依据用户提供的编号资料回答，"
    "每个结论后用 [编号] 标注出处；资料中没有的信息要明确说“资料未涉及”。"
    "历史案例只能作为排查参考，不得据此断定当前问题的根本原因，也不得给出停线、放行或责任判定的结论。"
    "用简体中文回答，结构：结论摘要、历史原因、可参考措施、建议验证步骤。"
)


class LLM:
    def __init__(self):
        self._client = None
        self._err = None
        if os.environ.get("SQM_LLM", "").lower() not in ("on", "1", "true"):
            self._err = "未启用（设置 SQM_LLM=on 并配置 ANTHROPIC_API_KEY 后可用）"
            return
        try:
            import anthropic
            self._anthropic = anthropic
            self._client = anthropic.Anthropic()
        except ImportError:
            self._err = "未安装 anthropic SDK（pip install anthropic）"
        except Exception as e:  # 缺少凭据等
            self._err = f"初始化失败：{e}"

    def enabled(self):
        return self._client is not None

    def status(self):
        return {"enabled": self.enabled(), "model": MODEL if self.enabled() else None, "reason": self._err}

    def _call(self, prompt):
        a = self._anthropic
        try:
            resp = self._client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                output_config={"effort": "low"},
                system=SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            )
        except a.RateLimitError:
            return None, "模型服务限流，请稍后再试"
        except a.APIStatusError as e:
            return None, f"模型服务返回错误 {e.status_code}"
        except a.APIConnectionError:
            return None, "无法连接模型服务"
        if resp.stop_reason == "refusal":
            return None, "模型拒绝回答该请求"
        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        return (text, None) if text else (None, "模型未返回内容")

    def answer(self, question, sources):
        prompt = "资料：\n\n" + "\n\n".join(sources) + f"\n\n问题：{question}"
        return self._call(prompt)

    def refine_brief(self, brief):
        prompt = ("下面是系统根据数据和知识库自动拼装的异常分析简报。请在不新增事实的前提下，"
                  "改写成面向质量经理的简明汇报（300 字以内），保留出处编号和需人工确认的事项。\n\n" + brief)
        return self._call(prompt)
