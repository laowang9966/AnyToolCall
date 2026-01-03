

# AnyToolCall

> 去™的原生工具调用！让任何 LLM 都能用上 Tool Calling。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

## 😤 问题

你是否也被这些问题折磨过？

| 模型 | 奇葩限制 |
|------|----------|
| **Gemini** | 相同 role 的消息不能连续出现 |
| **Claude** | tool_call 必须紧跟 tool_result，ID 必须对齐 |
| **Gemini 3** | tool_call 必须附带思维链签名 |
| **某些模型** | 压根不支持 function calling |
| **OpenAI 兼容层** | 各种奇怪的 400 错误 |

切换模型？历史消息格式不兼容，炸了。  
并行调用？多个 tool result 连续出现，炸了。  
想用开源模型？不支持原生 tool calling，炸了。

## 💡 解决方案

**AnyToolCall** 是一个 OpenAI 兼容的 LLM 代理中间件，通过**提示词注入**的方式实现工具调用，绕过所有原生限制。

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────┐
│   Client    │ ───▶ │  AnyToolCall     │ ───▶ │  Any LLM    │
│ (tool_call) │      │  (转换为文本)     │      │  (纯文本)    │
└─────────────┘      └──────────────────┘      └─────────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │ 解析文本定界符    │
                     │ 还原为 tool_call  │
                     └──────────────────┘
```

## ✨ 特性

- 🔄 **通用兼容** - 任何支持文本生成的 LLM 都能用上工具调用
- 🌊 **流式支持** - 完整支持 SSE 流式输出，实时解析 tool call
- 🎯 **智能定界符** - 使用生僻字组合（如 `ꆈ龘ᐅ`），极低冲突率
- 🧹 **自动清洗** - 自动处理历史消息中的 tool/tool_call，解决跨模型切换问题
- 🔀 **消息合并** - 自动合并连续相同 role 消息，告别 Gemini 400 错误
- 🔒 **安全防护** - 内置 SSRF 防护，可控制内网访问权限
- 📝 **调试日志** - 可选的详细日志记录，方便排查问题

## 🚀 快速开始

### 安装

```bash
git clone https://github.com/aliyahzombie/AnyToolCall.git
cd AnyToolCall
npm install
```

### 运行

```bash
# 基础模式（禁止访问内网）
node index.js

# 开发模式（允许访问本地 LLM）
ALLOW_LOCAL_NET=true node index.js

# 调试模式（开启日志）
LOG_ENABLED=true node index.js
```

### 使用

只需将 API 地址改为经过 AnyToolCall 代理：

```bash
# 原来的请求
curl https://api.openai.com/v1/chat/completions

# 改为
curl http://localhost:3000/https://api.openai.com/v1/chat/completions
```

就是这么简单！你的 tool calling 请求会被自动转换。

## 📖 工作原理

### 1. 请求转换

原始请求中的 `tools` 定义被转换为系统提示词：

```
## Tool Calling

You have access to the following tools:
- **web_search**: 搜索互联网
  Parameters: {"query": "string", "limit": "integer"}

### How to call tools

ꆈ龘ᐅ
ꊰ▸function_name◂ꊰ
ꊰ▹{"param": "value"}◃ꊰ
ᐊ龘ꆈ
```

### 2. 消息转换

| 原始格式 | 转换后 |
|----------|--------|
| `role: "tool"` | `role: "user"` + 定界符包裹 |
| `assistant.tool_calls` | 纯文本 + 定界符 |
| 连续相同 role | 合并为单条消息 |

### 3. 响应解析

从模型的文本响应中解析定界符，还原为标准的 `tool_calls` 格式。

## ⚙️ 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ALLOW_LOCAL_NET` | `false` | 是否允许代理到内网地址 |
| `LOG_ENABLED` | `false` | 是否保存详细日志 |
| `LOG_DIR` | `./logs` | 日志保存目录 |

## 🎭 定界符设计

为什么用生僻字而不是 `<<<TOOL_CALL>>>` 这种？

| 方案 | 问题 |
|------|------|
| XML 标签 `<tool>` | 容易与代码/文档内容冲突 |
| 特殊符号 `###` | Markdown 中太常见 |
| 零宽字符 | LLM 无法准确复制 |
| **生僻字组合** ✅ | 可见、可复制、极低冲突率 |

我们使用多语系生僻字混合：

```
藏文 + 中文生僻字 + 加拿大原住民文字
  ༒       龘           ᐅ
```

每次启动随机选择，进一步降低冲突概率。

## 🔧 兼容性

在Claude4.5系列 Gemini2.5/Gemini3系列 GPT-5.2 工作良好

## 📝 示例

### 客户端代码（无需修改）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/https://api.openai.com/v1",
    api_key="sk-xxx"
)

response = client.chat.completions.create(
    model="gpt-5.2",
    messages=[{"role": "user", "content": "搜索今天的新闻"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "搜索互联网",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                }
            }
        }
    }]
)

# tool_calls 正常返回，就像原生支持一样
print(response.choices[0].message.tool_calls)
```

## 🛡️ 安全

- **SSRF 防护**：默认禁止代理到内网地址（127.0.0.1, 192.168.x.x, 10.x.x.x）
- **协议限制**：仅允许 HTTP/HTTPS
- **无状态**：不存储任何请求数据（除非开启日志）

## 🤝 贡献

欢迎 PR 和 Issue！

## 📄 License

MIT

---

**AnyToolCall** - 因为工具调用不应该这么难。
