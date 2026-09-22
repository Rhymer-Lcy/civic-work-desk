# UOS 发布流程

> **状态：Stage A。** 下面描述的是发布 RC1 验收包的流程；正式发布包（面向最终用户）的流程在
> 服务方案选定之后补齐，标记为「待 Stage B」的小节现在还不能执行。

## 角色与机器

|      | 机器                  | 需要什么         |
| ---- | --------------------- | ---------------- |
| 构建 | 开发工作站（Windows） | Node 24 / npm 11 |
| 验收 | 目标 UOS 工作站       | 什么都不用装     |
| 使用 | 同上                  | 同上             |

Node 与 npm **只存在于构建机**。产物是静态文件。

## 一、构建

```sh
npm ci
npm run review:package    # 跑全部质量闸门并生成工程评审包
```

`review:package` 内含 `npm run build`，所以 `dist/` 一定与本次闸门运行一致。
**不要**手工跑 `npm run build` 之后直接打包——E2E 套件不会重新构建，很容易对着旧产物做判断。

## 二、组装 RC1 验收包

```sh
sh scripts/uos/build-rc1.sh        # 待 Stage B：正式版用 build-release.sh
```

它做四件事：把 `dist/` 复制进 `release/uos-rc1/app/`、写入 `deployment-health.json`（含应用 commit）、
写 `VERSION`、生成 `SHA256SUMS.txt`。

生成后必须自检一次：

```sh
cd release/uos-rc1 && sh scripts/verify-files.sh
node scripts/uos/lint-shell.mjs
```

后者检查的是这套部署自己的不变量：规范地址逐字一致、不需要 sudo、不按端口杀进程、
POSIX shell 无 bash 语法、Python 不用 3.8+ 语法。

## 三、传输

打成 `.tar.gz` 传到目标机。**是否用 tar/gzip 交付，取决于探针确认目标机有这两个工具**——
RC1 的探针会报告它们是否存在。整包的 SHA-256 单独告知接收方，包内文件的清单在 `SHA256SUMS.txt`。

## 四、验收（在目标机上）

见 `docs/uos-target-acceptance.md` 与包内 `acceptance/TARGET_ACCEPTANCE.md`。

## 五、待 Stage B：正式发布包

在服务方案选定之后，正式发布包与 RC1 的区别是：

- 只包含安装和使用需要的东西，不含两个候选、不含验收手册、不含结果表；
- 含最终启动器、`.desktop` 文件、图标、安装与卸载脚本；
- 版本号进入 `VERSION` 与 `deployment-health.json`，与 `releases/<版本号>/` 目录名一致；
- 命名形如 `civic-work-desk-uos20-loongarch64-<版本>.tar.gz`。

## 六、发布元数据

每个发布包的 `VERSION` 至少记录：应用版本、应用 commit、Phase-3 发布 commit、构建时间、
经过实测的目标机指纹、规范地址、选定的服务方案、以及 SHA-256 清单的位置。

「经过实测的目标机指纹」这一项，在 Stage B 之前**必须**写 `targetTested=NO`。
