# T3Tools (Windows)

面向 **Windows 桌面版 T3 Code** 的零改包原生增强插件，重点支持 **Antigravity（含多账号实例，如 `work` / `antigravity`）+ Codex**（并兼容 T3 Code 内置扫描的其他驱动）。

## 核心功能（Phase 1 ~ Phase 3）

1. **输入框旁实时监控条**
   - 实时查看当前会话的上下文窗口占用（进度条 + Token / 百分比 + 分类与压缩次数提示）、缓存命中率与约 5 分钟缓存保活观察倒计时、以及生成速度（流式生成中实时估算，落盘后自动校准为精确 `tok/s` + `TTFT`）。
2. **可折叠运行进度 & 模型组剩余额度浮窗**
   - 展示当前运行阶段（深度思考 / 执行命令 / 调用工具 / 等待权限确认 / 空闲）、当前 Turn 每步耗时明细，以及所有已启用实例（Antigravity 多实例 + Codex）各模型组的 5 小时 / 周剩余额度与重置倒计时；点击标题栏一键折叠收起并自动记住状态。
3. **周限额周期用量概览（含 53 周热力图 & 模型健康状态）**
   - 默认按本轮周限额周期（基于各模型池 `resetsAt - 7d` 动态计算）统计请求次数、Token 细拆、缓存命中率、参考费用（接入 T3 Code `usage-model-rates.json` 费率表与兜底价）、**53 周 SVG 贡献热力图**（支持切换 Token / 请求数 / 费用）与 **模型健康状态**（成功率、重试率、429/503/超时/EOF 错误归类）。
4. **原生深浅色主题同步 & 多模型对比**
   - 实时监听 T3 Code `html.dark` 及宿主 CSS 变量（`--background` / `--card` / `--foreground` / `--border` / `--accent` / `--chart-1..6`），毫秒级跟随客户端切换浅色与深色主题；并排对比各模型的 Token 占比、费用占比、缓存命中率和平均/峰值速度。
5. **请求明细多维筛选 & 异常掉缓存精准标出**
   - 支持按账号/实例、模型、会话、状态及「仅看异常掉缓存」筛选单次请求；精准标出短间隔（默认 `<= 180s`）内的 `缓存归零` / `命中骤降` / `连续未命中`，并自动排除**冷启动**与**上下文压缩**（Antigravity `step_type=23` / Codex 压缩事件 + 输入骤降比例双保险）误报。

## 为什么能抗 T3 Code 更新？

- **零修改安装包**：完全不碰 `app.asar` / `server.asar`，只读解析 `~/.t3/userdata/statev2.sqlite`、Antigravity ACP 会话库、Codex Rollout 日志和 `~/.t3/caches/*.json`，自有索引存放在 `~/.t3tools/telemetry.sqlite`。
- **不耦合宿主混淆代码**：通过 Windows 快捷方式追加 `--remote-debugging-port=0` 并用 CDP 挂载 **Shadow DOM** 隔离 UI；所有 DOM 锚点外置在 `config/selectors.json`，优先使用 T3 Code 官方稳定 `data-*` 选择器。
- **独立 Web Fallback 兜底**：守护进程同时提供本地 `http://127.0.0.1:17373`，即便 T3 Code 大改临时导致 DOM 锚点失效，浏览器打开该地址依然可 100% 使用全部功能。

## 快速开始（Windows，Node.js >= 22.13，零 npm 依赖）

默认采用 **Magpie 风格独立托盘模式（`T3Tools.exe`，右下角系统托盘 + 自动吸附 T3 Code）**：

```powershell
# 1. 一键编译并安装托盘程序（零 npm 依赖，调用系统内置 .NET 编译器生成 T3Tools.exe）
#    自动创建桌面/开始菜单「T3Tools」快捷方式，并为 T3 Code 快捷方式注入 --remote-debugging-port=0
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 可选参数：同时开启开机自启 / 启动即缩放到右下角托盘
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -AutoStart -StartMinimized
```

安装完成后：
- **右下角托盘常驻**：双击「T3Tools」启动，点击最小化、关闭（`×`）或「缩放到托盘」即可缩放到右下角系统托盘；单击/双击托盘图标随时恢复主控窗口，右键菜单可一键打开看板、开关自动吸附、开机自启或退出。
- **启动后自动吸附 T3 Code**：托盘程序启动后会静默拉起后台守护进程（零黑框，随托盘退出自动清理），1.5 秒内自动探测并吸附到 T3 Code 窗口；若检测到 T3 Code 已打开但尚未开启调试端口，托盘图标会亮起琥珀色提示并提供一键「重启 T3 Code 并吸附」。
- **仍兼容原方案 A（图标联动启停）**：如需不常驻托盘、随 T3 Code 同启同退，可运行 `.\scripts\install.ps1 -WrapperMode`。

### 常用命令

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-tray.ps1  # 单独编译 dist\T3Tools.exe
node bin/t3tools.mjs tray              # 启动 T3Tools 托盘程序（可加 --tray 直接静默进托盘）
node bin/t3tools.mjs patch-debug       # 仅为 T3 Code 快捷方式注入 --remote-debugging-port=0
node bin/t3tools.mjs doctor            # 环境、托盘、进程与数据源一键诊断
node bin/t3tools.mjs status            # 查看运行中的守护进程与 CDP 挂载状态
node bin/t3tools.mjs stop              # 手动停止守护进程
node bin/t3tools.mjs snapshot          # 命令行快速预览当前会话与本轮周统计
node --test tests/*.test.mjs           # 运行全部单元测试与集成测试
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1  # 一键无损还原并移除托盘与自启
```
