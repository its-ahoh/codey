# Playbook = Codey 学出来的 Skill

状态：已确认，开始实现 · 2026-10-19 · 取代 #470 的"每轮目录"方案

## 1. 一句话

你回"yes"保存一个 playbook 时，Codey **直接把它写成真正的 `SKILL.md`**，放进各家 agent 本来就会找 Skill 的地方。之后用不用、怎么用、什么语言、单人还是团队，全部交给 agent 自己的 Skill 机制。

Playbooks 页面变成"Codey 学出来的 Skill"的管理页：看有哪些、用了几次、删掉、回滚、切换范围。

## 2. 新的流程

```
跑完一轮 → 记录运行 → 找重复（代码） → 起名（AI，本来就有的那次调用）
        → 问你"要存吗？" → 你回 yes
        → 写 SKILL.md → 同步到 agent 的目录 → agent 自己发现、自己决定用不用
        → Codey 从工具调用里看到"用了" → 记次数 → 够次数就进化 → 改写 SKILL.md
```

跟现在相比：
- **没有"升级成 Skill"这一步。** 存了就是 Skill。
- **没有每轮的目录。** #470 那套不要了。
- **没有 Codey 自己的匹配。** 关键词、强匹配、目录都不要。

## 3. 命名：固定前缀 `playbook-`

- 名字 = `playbook-<AI 起的名字>`，例如 `playbook-post-to-x`、`playbook-release-notes`。磁盘上、agent 看到的、Codey 界面上显示的，都是这同一个名字。
- **前缀由代码加，不让 AI 写。** AI 只起后面那段，规则是 `/^[a-z][a-z0-9-]*$/`、3–30 个字符。这样满足所有 agent 对 Skill 名字的要求：小写、连字符、和目录同名。不用冒号，因为冒号不合规，Windows 目录名也不允许。
- 前缀的作用：
  1. **一眼看出**哪些是 Codey 学的，按名字排序时也会排在一起。
  2. **不会跟你自己的 Skill 重名。** 万一还是重名了，保存时提示你改名，绝不覆盖。
  3. **git 忽略规则只要写一次**（见第 5 节）。
  4. **追踪使用很简单**（见第 7 节）。
- 你回 `rename <新名字>` 时，前缀照样自动加上。

## 4. 放在哪：范围 = 目录

| 范围 | `SKILL.md` 写到 | 写完后同步 |
|---|---|---|
| 通用 | `~/.codey/skills/playbook-<名字>/` | `syncCodeyGlobalSkills()` |
| 项目 | `<项目>/.codey/skills/playbook-<名字>/` | `syncCodeyProjectSkills(workingDir)` |

同步会在 `.claude/skills/` 和 `.agents/skills/` 下面建链接，Claude Code、Codex、OpenCode、pi 都能找到。这套同步代码现在升级 Skill 时就在用。

### 范围怎么定（PR B）

存之前先给一个建议，按顺序判断：

1. 同一套做法在 **2 个以上 workspace** 里都出现过 → 通用
2. 改过项目里的文件、在项目目录里跑过命令 → 项目
   （要在运行记录的 `path` 形状里加一个 `inProject: boolean`，只记"在不在项目里"，不记路径本身。）
3. 只用了浏览器、只访问了外部网站 → 通用
4. 都看不出来 → 用起名 AI 顺手给的 `scope` 字段（同一次调用，不多花）
5. AI 也没给 → 项目

然后在保存提示里问你：

> 🧩 我好像反复在做这件事（"在 X 上发帖"）。要存成**通用** Skill **playbook-post-to-x** 吗？
> 回 `yes` 保存 · `no` 不要 · `project` 改成只给这个项目 · `rename <新名字>` 换个名字

如果建议的是项目，选项就换成 `global`。Mac 聊天和频道两条路都要支持。之后在 Playbooks 页面也能切换：把目录挪过去，两边各重新同步一次。从通用改回项目时，挪到**当前打开的 workspace**。版本历史、使用次数都跟着走；目标那边已经有同名的就拒绝。

## 5. 项目 Skill 只留在本机

项目 Skill 写在你的仓库里。为了不出现在 `git status` 里，Codey 第一次往某个仓库写 Skill 时，会在这个仓库的 `.git/info/exclude` 末尾加一段**固定的规则**：

```
# >>> codey learned skills (local only)
/.codey/skills/playbook-*
/.claude/skills/playbook-*
/.agents/skills/playbook-*
# <<< codey learned skills
```

- `.git/info/exclude` 跟 `.gitignore` 作用一样，但**只在你这台电脑上生效**，不会被提交。
- 因为名字都以 `playbook-` 开头，**这段规则写一次就够了**，之后存再多 Skill 都不用改。已经有这段就跳过。
- 路径用 `git rev-parse --git-path info/exclude` 去找，这样 git worktree 也能处理对。
- 项目不是 git 仓库：不用处理，跳过。
- 想跟团队分享：自己删掉这段，或者删掉其中某一行。Codey 用 Skill 存储里的一个标记记住"已经加过"，你删了它也不会再加回去。

通用 Skill 放在 home 目录，不在任何仓库里，不涉及这个问题。

## 6. Codey 自己还存什么

`workspaces/<名字>/skills/index.json`（`SkillStore`）继续保留，但角色变了：它只是**账本**，记每个 Skill 的版本历史、使用次数、成功次数、范围、`SKILL.md` 的位置。真正给 agent 用的是 `SKILL.md`。

- 通用 Skill 的账本放在 `~/.codey/skills-ledger/skills/index.json`（PR B，跟着 `CODEY_HOME` 走）。它不属于任何一个 workspace，所以不能放在 workspace 里；也不能放进 `~/.codey/skills/`，那里的每个目录都会被当成一个 Skill。
- **你手动改了 `SKILL.md`**：Codey 每次写文件都会记下内容的指纹。下次要动这个文件之前（进化、回滚、恢复），先比一下指纹。对不上就说明你改过，Codey 会**把你改的内容存成一个新版本**，以后在这一版的基础上继续进化。你的改动永远留在版本历史里，随时能回滚到你那一版。手动改过的 Skill 不会被自动清理。

## 7. 怎么知道用过

在这一轮的工具调用里，出现下面任意一种，就记一次使用：
- 调用了 `Skill` 工具，参数是这个名字（Claude Code 的做法）
- 读了这个 Skill 的 `SKILL.md` 文件（其他 agent 的做法）

名字都以 `playbook-` 开头，所以只要在工具调用里找这个完整的名字就行。比对时按整词匹配，避免 `playbook-x` 误中 `playbook-x-y`。

团队任务里，任何一个 bot 用了，都算这一轮用了一次；同一轮里用多次也只记一次。

缺口：opencode 和 codex 不上报工具调用，它们用了也记不上，进化也就不会触发。所以清理规则对这两家要放宽（见第 9 节）。

## 8. 进化和回滚

- 每用满 3 次、而且是成功的那几轮，让 AI 看一下步骤要不要改（跟现在一样）。
- 要改的话：新版本写进账本，再**重新生成 `SKILL.md`**。版本号写在正文的标题里，不放进 frontmatter（文件开头那段元数据），免得有的 agent 不认识多出来的字段。
- 回滚：从账本里取出上一版，重新生成文件。
- 手动改过的文件（第 6 节）：先存成新版本，再在它的基础上进化。

## 9. 清理

- 规则不变：30 天没用过，或者建好 7 天、用了不到 2 次，就自动归档。
- **归档 = 删掉 `SKILL.md` 的目录 + 重新同步。** 同步会顺手把指向它的失效链接也删掉。内容还留在账本里，可以在 Playbooks 页面恢复。
- **手动改过的不自动清理。** 那已经是你的东西了。
- 用 opencode 或 codex 的 workspace：使用记不上，所以"用得少"这条规则不适用，只看"30 天没动过"。

## 10. 老数据

- **已经存过、还没升级的 playbook**：你当初回过"yes"，所以第一次用到时自动改名成 `playbook-<名字>` 并写成 Skill，范围是项目。
- **已经升级过的**：它们已经是 `SKILL.md`（没有前缀），算是你的了。保持原样，Codey 不再改它们，Playbooks 页面里标成"旧版升级"。
- **已归档的**：保持归档。

## 11. 要删掉的东西

- #470 整个方案：`preparePlaybookIndex`、`withPlaybookIndex`、`PLAYBOOK_INDEX_MAX`、每轮目录。
- 升级这一步：Playbooks 页面的"升级"按钮、`promotePlaybook`、`promotedToSkill` 的新写入、`promotionHinted` 和升级提醒。
- 上一版方案里的 `~/.codey/global-playbooks/` 存储。
- #469 里的 `matchSkill`、`suggestPlaybook` 和"只建议强匹配"。

**保留**：手动 `/skill <名字> <任务>`，它会直接把步骤塞进提示词，你明确指定的时候用得上。

## 12. 顺手修的小问题

Skills 页面里，`browser` 被标成 Codey 管理的（显示 `codey:browser`），但同样是 Codey 装的 `chrome-companion` 没有被标上。原因是 `codey-mac/electron/main.ts` 只给 `browser` 和插件包打了标记。这次一起修好。

## 13. 测试

- 命名：前缀由代码加；AI 起的名字超长或者格式不对就拒绝；重名提示改名，不覆盖。
- 写入：项目的写进 `<项目>/.codey/skills`（PR B 再加通用的，测试里 `CODEY_HOME` 指向临时目录）；写完触发同步。
- exclude：第一次写入时加上那段规则；第二次不重复加；不是 git 仓库就跳过；worktree 能找到正确的文件；用户删掉过就不再加。
- 手动修改：指纹对不上时，先把文件内容存成新版本，再进化；不自动清理。
- 使用追踪：`Skill` 工具调用和读 `SKILL.md` 都能识别；整词匹配；团队一轮里只记一次。
- 归档 / 恢复：目录删掉，链接也跟着清掉；恢复后重新生成。
- 迁移：没升级的改名成 `playbook-` Skill；升级过的不动。
- 范围建议（PR B）：跨 workspace → 通用；改了项目文件 → 项目；只用浏览器 → 通用；AI 建议；默认项目。
- `chrome-companion` 在 Skills 页面被标成 Codey 管理的。

## 14. 分几步做

- **#469**：照常合并。它删掉了一次多余的 LLM 确认调用，马上能省 token。
- **#470**：已关闭，被这个方案取代。
- **PR A（叠在 #469 上）**：存了就写成 `playbook-` Skill + 同步 + exclude + 账本 + 使用追踪 + 进化 / 回滚 / 清理改写文件 + 迁移老数据 + 删掉第 11 节的东西 + 第 12 节的小修复。范围先只有"项目"。
- **PR B**：通用范围 + 范围建议 + 保存提示里确认 + Playbooks 页面切换。
