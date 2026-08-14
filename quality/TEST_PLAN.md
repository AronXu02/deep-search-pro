# 工具调用测试计划

## 1. 目标与范围

本计划围绕 Deep Search Pro 的“模型决定调用工具 → 工具执行 → 监控事件推送 → 返回结果”的链路制定测试策略，覆盖以下边界：

- 主 Agent 的工具调用解析、子 Agent 调度、最终结果上报和异常收敛。
- 6 类工具：网络搜索、数据库查询 3 个工具、RAGFlow 助手列表/提问、Markdown 生成、Markdown 转 PDF、上传文件读取。
- 工具调用依赖的 ContextVar 会话隔离、路径解析、文件读写和 WebSocket 监控。
- `/api/task`、`/api/upload`、`/api/download`、`/api/files`、`/ws/{thread_id}` 对工具调用链的集成行为。

外部 LLM、Tavily、MySQL、RAGFlow 和 Microsoft Word 均采用 mock/fake 进行确定性测试；真实服务只作为最后的受控冒烟测试。本文只记录测试方案，不修改生产代码。

## 2. 项目现状与测试基线

项目说明确认：主 Agent 位于 `agent/main_agent.py`，通过 `deepagents` 调度网络搜索、数据库查询和 RAGFlow 子 Agent，并直接调用 Markdown、PDF、文件读取工具；工具调用进度通过 `api/monitor.py` 推送到 WebSocket。

当前工作区状态：

- 已修改：`agent/main_agent.py`、`tools/db_tools.py`。
- 未跟踪：`.python-version`、`main.py`、`pyproject.toml`、`uv.lock`。
- 当前 diff 主要是 `main_agent.py` 的格式整理，以及 `db_tools.py` 文档字符串调整；这些变更仍需由回归测试保护工具调用链。
- README 要求 Python 3.10+；当前 `pyproject.toml` 声明 `requires-python = ">=3.14"`，测试环境版本应在执行前统一。

已验证的现有命令：

| 命令 | 当前结果 | 结论 |
| --- | --- | --- |
| `python api/server.py` | 项目运行入口，需要 LLM 配置和外部服务 | 可作为人工运行/冒烟入口，不是自动化测试 |
| `.venv\\Scripts\\python.exe -m unittest discover -v` | `Ran 0 tests`，退出码 5 | 没有可执行的现有单元测试 |
| `.venv\\Scripts\\python.exe -m pytest --collect-only -q` | `No module named pytest`，退出码 1 | pytest 未安装，无法收集测试 |
| `pytest` | 命令不可用 | 没有全局 pytest 入口 |

仓库当前没有 `tests/`、测试配置或 pytest 依赖，`uv.lock` 也没有 pytest 包。建议后续统一采用 pytest + pytest-asyncio；本计划先锁定测试内容和通过条件。

## 3. 关键业务风险

| 风险 ID | 风险 | 影响 | 优先级 |
| --- | --- | --- | --- |
| R1 | 模型调用了错误工具，或在获取信息前调用文档生成工具 | 生成内容缺少事实依据，业务流程失真 | P0 |
| R2 | `tool_call` 缺少 `name`、`args`、`subagent_type` 或 `description` 时触发异常 | 流式任务中断，前端收不到可解释的错误事件 | P0 |
| R3 | 会话目录、`updated/`、绝对路径或 `..` 路径解析越界 | 跨会话读写、任意文件覆盖或数据泄露 | P0 |
| R4 | 上传文件名未做目录穿越校验 | 上传内容可能写入 `updated` 目录之外 | P0 |
| R5 | 数据库工具允许模型直接执行任意 SQL，且未验证只读性、表名和结果上限 | 数据破坏、敏感数据外泄、长时间查询 | P0 |
| R6 | 监控事件携带完整文件内容、SQL 或查询文本 | Cookie、密钥、业务数据和用户文件可能进入日志/WebSocket | P0 |
| R7 | ContextVar 或 WebSocket thread_id 串台 | A 用户看到 B 用户的工具进度或文件结果 | P0 |
| R8 | RAGFlow 查询列表为空、助手名不存在或流式提问中途失败 | 空列表索引异常，临时会话未删除，资源泄漏 | P1 |
| R9 | Tavily、MySQL、RAGFlow、Word 或文件解析器失败时错误语义不一致 | Agent 无法决定重试、降级或结束任务 | P1 |
| R10 | 工具事件重复、乱序、缺少 session_created/task_result 或跨事件循环投递失败 | 前端进度条错误，任务状态不可观测 | P1 |
| R11 | Markdown/PDF 输出路径、扩展名和覆盖行为不一致 | 文件生成成功提示与实际文件不一致 | P1 |
| R12 | 文件读取对空文件、编码、损坏 PDF/Office/Excel 和超大文件处理不稳定 | 任务失败或资源消耗过高 | P1 |

## 4. 测试策略与覆盖目标

采用测试金字塔：大量纯单元测试，少量组件/集成测试，最后安排少量真实依赖冒烟测试。

覆盖目标以业务分支为准：

- P0 规则、路径安全、会话隔离、监控脱敏、工具异常路径：分支覆盖 100%。
- 工具参数转发、返回值格式、资源清理：每个工具至少覆盖成功、空结果、外部异常 3 类场景。
- 主 Agent 流式解析：覆盖子 Agent 调用、直接最终结果、无消息、空内容、多个 tool call、格式异常和异常收敛。
- API/WebSocket：覆盖每个接口的成功、无效输入、越权输入；至少覆盖两个 thread_id 的并发隔离。
- 真实外部服务只做人工或隔离环境冒烟，不把网络、凭据、第三方数据状态作为 CI 通过条件。

## 5. 测试项与示例用例

### 5.1 路径、上下文与文件安全（P0）

| 用例 | 类型 | 重点断言 |
| --- | --- | --- |
| `resolve_path` 普通相对路径、嵌套目录、虚拟前缀 `/workspace`、`/mnt/data`、`/home/user` | 单元 | 结果落在当前 session 目录，路径分隔符稳定 |
| `session_123/session_123/file.md`、`output/file.md`、会话内绝对路径 | 单元 | 不产生重复 session 嵌套 |
| 会话外绝对路径、`..`、符号链接和不存在父目录 | 单元/安全 | 明确拒绝、保留待校验状态或不允许工具写入；不能通过工具写入任意位置 |
| `updated/` 路径和跨目录前缀 | 单元/安全 | 只解析到预期上传根目录；路径中伪造 `updated/` 不能扩大访问范围 |
| 两个异步任务分别设置 session/thread ContextVar | 异步单元 | 工具读取的目录和监控目标始终属于各自任务；任务结束后上下文恢复为 `None` |
| `/api/upload` 使用 `a.txt`、`sub/a.txt`、`..\\outside.txt`、绝对路径文件名 | API 集成 | 只允许安全文件名或安全相对路径，越界上传被拒绝且不产生越界文件 |
| `/api/download` 和 `/api/files` 访问 output 外部路径、目录、缺失文件 | API 集成 | 拒绝越权，不泄露外部路径内容；正常文件返回正确元数据/文件流 |

### 5.2 直接工具行为（P0/P1）

所有 `@tool` 测试应通过 `.invoke()` 或工具的底层函数调用，mock `monitor.report_tool`，并断言参数和调用顺序。

| 工具 | 必测场景 | 关键断言 |
| --- | --- | --- |
| `internet_search` | 默认参数、`news/finance/general`、自定义 `max_results`、原文开关、Tavily 异常 | Tavily 参数原样转发；先上报一次工具事件；异常转换为稳定错误结果或统一异常契约 |
| `list_sql_tables` | 有表、无表、连接错误、缺失环境变量、端口非法 | SQL 为 `show tables`；结果格式稳定；配置错误在连接前可解释地失败；不记录密码 |
| `get_table_data` | 合法表名、空表、100 行边界、数据库错误、恶意表名 | 查询包含明确行数上限；列头和行格式稳定；非法标识符不能注入任意 SQL |
| `execute_sql_query` | 只读查询、有结果、无结果、数据库错误、写入/多语句/超长查询 | 只允许约定的查询类型和范围；无结果有明确语义；结果大小受控；禁止未授权写操作 |
| `get_assistant_list` | 多助手、多知识库、无助手、缺少 datasets、SDK 异常 | 不因空列表或字段缺失崩溃；返回内容不包含凭据；monitor 参数结构一致 |
| `create_ask_delete` | 助手存在、无助手、流式多片段、提问异常、删除异常 | 先按名称选择助手；完整拼接流片段；成功和失败路径都验证临时会话清理；删除失败可观测 |
| `generate_markdown` | 自动补 `.md`、session 默认路径、子目录、覆盖已有文件、写入异常 | 文件内容和编码正确；目录范围符合策略；返回结果与实际文件一致；监控不发送完整敏感内容 |
| `convert_md_to_pdf` | 缺失源文件、默认 PDF 名、指定输出名、错误扩展名、Word 转换成功/失败 | 只解析 session 内文件；源文件不存在时不调用 Word；`.md/.pdf` 后缀稳定；转换异常可解释且临时文件清理 |
| `read_file_content` | md/txt、docx、pdf、xlsx/xls、缺失文件、损坏文件、未知二进制、空内容 | 文件类型分派正确；解析失败返回稳定错误；路径越界被拒绝；Excel 预览和统计不泄露不必要数据 |

### 5.3 主 Agent 工具调用与流程规则（P0）

使用 fake `main_agent.astream()` 产生确定性 chunk，避免真实 LLM 参与。

1. `model` 节点产生 `task` tool call：断言 `report_assistant(subagent_type, description)` 只上报一次，字段按调用内容传递。
2. 同一 chunk 包含多个 tool call：逐个处理，未知工具名不应导致整个任务崩溃，并产生可定位事件。
3. `model` 节点产生最终文本：断言调用 `report_task_result`，不重复上报助手调用。
4. 空 state、缺少 `messages`、空列表、非列表消息、`tool_calls=None`、消息没有 `content`：任务可结束或发出统一错误事件。
5. `tool_call` 缺字段、args 非字典、字段类型错误：禁止 `KeyError` 泄漏到后台任务；错误事件包含 session_id，且不包含秘钥和完整用户内容。
6. `astream` 抛出异常：断言收到一个错误事件，ContextVar 在 `finally` 中恢复，后续任务不继承旧 session/thread。
7. 有上传文件时：文件复制到当前 output session，提示词包含文件名；文件不存在、同名覆盖和复制失败均有测试。
8. 工作流顺序：当需求要求生成文件时，先有信息获取工具/子 Agent 成功结果，后调用文档生成；缺少前置结果时应阻止生成或返回可解释错误。该规则当前主要写在 prompt 中，计划要求补充可验证的流程契约测试。

### 5.4 监控与 WebSocket（P0/P1）

| 用例 | 关键断言 |
| --- | --- |
| `report_tool`、`report_assistant`、`report_session_dir`、`report_task_result` | event type、message、data 字段和 timestamp 存在且类型正确 |
| 无 WebSocket manager、无 thread context | 控制台/脚本 fallback 不抛异常，不误发到未知会话 |
| 同事件循环发送、跨线程发送、发送协程抛错 | 投递方式正确，异常被隔离，不阻塞工具主流程 |
| 两个 thread_id 同时连接并接收事件 | 每条消息只到目标连接，断开后连接表清理 |
| monitor 参数含 SQL、文件内容、Token 形态字符串 | 默认脱敏/截断；测试通过前禁止把敏感完整值写入 WebSocket 或日志 |
| `/ws/{thread_id}` 连接、心跳、断开、异常 | `pong` 内容正确；断开后 manager 不残留连接 |

### 5.5 API 与端到端冒烟（P1）

使用 FastAPI `TestClient`/异步客户端并 monkeypatch `run_deep_agent`：

- `/api/task` 有 query、缺 query、空 query、提供/不提供 thread_id：立即返回 `started` 和稳定 thread_id；后台任务只创建一次。
- `/api/task` 的后台 Agent 失败：HTTP 已响应不被拖挂，错误通过监控事件可见。
- 上传 → Agent 读取 → Markdown 生成 → 下载：在 fake 工具链下验证 session 文件闭环和结果事件闭环。
- WebSocket 建立后调用 `/api/task`：只收到对应 thread_id 的 `session_created`、工具/助手进度、`task_result` 或 `error`。
- 并发提交两个任务：输出目录、上下文、WebSocket 事件和最终文件互不混淆。

## 6. 暂不覆盖的内容

以下内容暂不作为本轮工具调用测试的通过条件：

- LLM 是否能稳定理解自然语言、选择最优工具和编写高质量答案；只验证可观察的调用契约和流程顺序。
- Tavily、MySQL、RAGFlow 的真实网络可用性、配额、数据正确性和服务端性能；这些放入隔离环境冒烟。
- Microsoft Word COM 在不同 Office 版本、桌面会话、打印机/字体环境下的版式一致性；先 mock 转换器，再安排 Windows 专项冒烟。
- 高并发压测、长时间运行、断电恢复、进程重启后的 checkpoint 持久化；当前使用 `InMemorySaver`，暂不验证持久化语义。
- 认证、权限模型和 CORS 策略的完整安全评审；本计划只验证工具调用相关的路径边界和会话隔离。
- 依赖库内部实现、框架自身的 WebSocket/Agent 调度逻辑，以及 `rawflow/` 下独立示例。
- 大文件性能、恶意压缩包、复杂 Office 宏和 PDF 主动内容；后续安全专项另立计划。

## 7. 执行顺序

1. **环境与测试基座**：统一 Python 版本，添加 pytest、pytest-asyncio、httpx 等测试依赖；建立 `tests/unit`、`tests/integration`、`tests/contract` 和临时目录 fixture。此步骤只改测试配置/测试代码。
2. **纯函数和安全边界**：先测 `resolve_path`、ContextVar、数据库配置解析、结果格式化，优先消除越界和串台风险。
3. **工具单元测试**：按数据库 → RAGFlow → 文件读写 → Markdown/PDF → Tavily 执行；所有第三方调用 mock，先验证事件再验证外部调用和返回值。
4. **监控组件测试**：覆盖事件 schema、thread 路由、事件循环分支、断开清理和脱敏断言。
5. **主 Agent 流程测试**：注入 fake stream，覆盖正常调用、异常 chunk、未知工具、前置顺序和 ContextVar 清理。
6. **API 集成测试**：覆盖 task/upload/download/files/WebSocket，以及双 session 并发隔离。
7. **受控冒烟**：在明确授权、隔离凭据和测试数据下运行真实 Tavily/MySQL/RAGFlow/Word；失败只标记外部依赖状态，不阻断纯单元测试结果。
8. **回归与报告**：执行全量测试、覆盖率和静态检查，记录失败用例、外部依赖版本、Python 版本与工作区 commit。

## 8. 通过条件

### 必须满足

- 所有 P0 用例通过，P0 失败时不得合并涉及工具调用链的变更。
- 工具调用参数、事件类型、目标 thread_id、文件归属和错误语义均有可重复断言。
- 任意 session 的工具调用都不能读写其他 session 或项目根目录外的目标。
- SQL、文件内容、Token 形态输入不会以完整值进入 monitor/WebSocket 测试捕获的 payload。
- 外部依赖失败可被测试捕获，后台任务不会产生未处理异常；ContextVar、RAG 临时会话、WebSocket 连接和临时 HTML 均完成清理。
- 全量自动化测试命令退出码为 0；覆盖率达到第 4 节目标，或对未达标项给出明确豁免和后续 issue。

### 可接受的受控失败

- 真实外部服务冒烟因凭据、网络、配额或服务状态失败时，不影响 mock 单元/集成测试通过；报告必须标明外部失败原因和时间。
- Word COM 专项测试只能在具备 Word 的 Windows 机器执行；CI 中使用 fake converter，并保留专项测试结果。

## 9. 交付与证据

首次实现测试后，测试报告至少应包含：执行命令、Python/依赖版本、通过/失败/跳过数量、覆盖率、P0 结果、外部冒烟状态，以及未覆盖项。若工具契约发生变化，应同步更新本计划和对应的 contract test。
