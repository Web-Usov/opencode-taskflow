# opencode-taskflow

Плагин для **OpenCode V2**, который переносит в любой проект процесс «эпик → задачи → worktree → PR → ревью → слияние»,
обкатанный в проекте finance. Роли агентов, детерминированные инструменты для системы задач, цепочки моделей (идея из
oh-my-openagent) и ограничения прав — одной строкой в конфиге.

## Что внутри

| Часть | Что делает |
|---|---|
| **Роли-агенты** | `lead` (оркестратор), `planner`, `implementer`, `reviewer`, `qa`. Промпты собираются из конфига проекта (команда проверки, защищённые пути, ветка, язык). Модель — первая доступная из цепочки. Права — по роли. |
| **Инструменты `tf_*`** | `tf_status`, `tf_next`, `tf_task`, `tf_start` (worktree + ветка + env + claim-коммит), `tf_set`, `tf_check`, `tf_board`, `tf_clean`, `tf_models` (doctor), `tf_dispatch` (запуск роли дочерней сессией), `tf_init`. |
| **Команды** | `/tf-next`, `/tf-ship`, `/tf-review`, `/tf-handoff`, `/tf-status`, `/tf-plan`, `/tf-drive`, `/tf-milestone`, `/tf-init`, `/tf-doctor`. |
| **Guard** | Хук прав: никто, кроме planner, не правит защищённые пути; никто, кроме reviewer, не запускает `gh pr merge`. Работает, даже если файл агента в проекте переопределил права. |

Процесс целиком описан в контракте, который получает каждая роль (`src/roles.ts`, функция `contract`), и в
`docs/taskflow.md`, который создаёт `/tf-init`.

## Установка

Требуется OpenCode ≥ 2.0.22, `git`, для PR-части — `gh` с авторизацией.

```bash
git clone git@github.com:Web-Usov/opencode-taskflow.git ~/plugins/opencode-taskflow
```

Подключить глобально (для всех проектов) — `~/.config/opencode/opencode.json(c)`:

```jsonc
{ "plugins": ["/root/plugins/opencode-taskflow"] }
```

или только в проекте — `.opencode/opencode.jsonc` с тем же содержимым. Путь указывает на **папку** плагина
(OpenCode загружает её `index.ts`). Зависимостей во время выполнения нет.

## Быстрый старт в проекте

1. `/tf-init` — создаёт `.opencode/taskflow.jsonc` (с найденными командами проверки и установки), шаблон задачи,
   README эпиков, пример эпика, шаблоны PR, `docs/taskflow.md`, секцию в `AGENTS.md` и доску задач. Ничего не перезаписывает.
2. Поправьте `.opencode/taskflow.jsonc` (команды проверки, обязательные CI-проверки, защищённые пути, области задач,
   env-файлы для worktree) и закоммитьте.
3. `/tf-plan E-01` — planner раскладывает эпик на задачи (PR на ревью человеку).
4. `/tf-next` → `/tf-next T-001` — взять задачу в работу руками, или `/tf-drive` — оркестратор сам ведёт готовые задачи
   до слияния: implementer → reviewer → доработка (до `review.maxRounds` кругов) → слияние → `tf_clean`.
5. `/tf-status` и `/tf-doctor` — состояние доски, PR, CI и какие модели выбраны для ролей.

## Конфигурация

Слои (каждый следующий важнее): встроенные значения → `~/.config/opencode/taskflow.jsonc` → `.opencode/taskflow.jsonc`
проекта → `options` плагина в `opencode.json`. Объекты сливаются, массивы заменяются.

```jsonc
{
  "language": { "human": "ru", "agent": "en" },        // язык для человека и для агентских артефактов
  "git": { "remote": "origin", "baseBranch": null,      // null = определить (origin/HEAD, main, master)
           "branchPrefix": "task/", "worktreeDir": "../{repo}-wt" },
  "paths": { "tasks": "tasks", "epics": "epics", "board": "tasks/README.md", "template": "tasks/_template.md" },
  "task": { "areas": ["api", "web", "mobile", "infra", "docs"], "sizes": ["S", "M"], "idPadding": 3 },
  "setup": {                                             // выполняется в каждом новом worktree
    "copy": ["apps/api/.env", { "to": "apps/api/.env.test", "from": ["apps/api/.env.test", "apps/api/.env.test.example"] }],
    "commands": ["pnpm install --frozen-lockfile --prefer-offline"]
  },
  "verify": { "full": "pnpm verify", "quick": "pnpm verify:quick", "e2e": "pnpm e2e:smoke" },
  "ci": { "checks": ["verify", "contract", "e2e"] },
  "protected": ["docs/spec/**", "docs/decisions/**", "epics/**"],
  "qaPaths": ["e2e/**"],
  "spec": null,                                          // или { dir, definition, questions, questionPattern, acceptancePattern }
  "review": { "maxRounds": 3, "autoMerge": true, "mergeMethod": "squash" },
  "parallel": 2,                                         // максимум одновременных implementer'ов в /tf-drive
  "agents": {                                            // цепочки: первая доступная модель побеждает
    "implementer": { "models": ["claude-code/claude-opus-5-5#medium", "anthropic/claude-opus-5-5#medium"] },
    "reviewer":    { "models": ["openai/gpt-6-astra#high", "claude-code/claude-opus-5-5#high"] },
    "qa":          { "disable": true }
    // также: name (id агента), model, permissions (доп. правила)
  },
  "categories": { "quick": { "models": ["claude-code/claude-sonnet-5-5#medium"] } },
  "routing": [ { "when": { "size": "S" }, "category": "quick" } ],   // модель implementer'а по размеру/области задачи
  "commandPrefix": "tf-"
}
```

Полные значения по умолчанию — `defaultConfig()` в `src/config.ts`.

### Модели

Как в oh-my-openagent, но без зашитого каталога провайдеров: цепочка — обычный конфиг, доступность берётся из реестра
моделей OpenCode. Вариант, которого у модели нет, отбрасывается (модель остаётся) — это видно в `/tf-doctor`.
По умолчанию reviewer предпочитает другое семейство моделей, чем implementer (перекрёстное ревью ловит больше).
Если ни одна модель цепочки недоступна, роль наследует модель сессии.

### Переопределение ролей файлами

Файл `.opencode/agents/<role>.md` в проекте побеждает плагин по каждому полю, которое в нём задано (например, свой
промпт), а незаданные поля (модель, права) остаются от плагина. Так подключаются проекты, у которых уже есть свои
агенты. Guard-хук действует в любом случае.

## Разработка

```bash
bun install
bun run check        # tsc + bun test
bash scripts/e2e.sh  # загрузка в реальный OpenCode и проверка через API (см. скрипт)
```

Архитектура и решения — `docs/ARCHITECTURE.md`. Планы — `docs/ROADMAP.md`.
