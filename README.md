# opencode-taskflow

Плагин для **OpenCode V2**, который переносит в любой проект процесс «эпик → задачи → worktree → PR → ревью → слияние»,
обкатанный в проекте finance. Роли агентов, детерминированные инструменты для системы задач, цепочки моделей (идея из
oh-my-openagent) и ограничения прав — одной строкой в конфиге.

## Что внутри

| Часть | Что делает |
|---|---|
| **Роли-агенты** | `lead` (оркестратор), `planner`, `implementer`, `reviewer`, `qa`. Промпты собираются из конфига проекта (команда проверки, защищённые пути, ветка, язык). Модель — первая доступная из цепочки. Права — по роли. |
| **Инструменты `tf_*`** | `tf_status`, `tf_next`, `tf_task`, `tf_start` (worktree + ветка + env + claim-коммит), `tf_set`, `tf_check`, `tf_board`, `tf_clean`, `tf_models` (doctor), `tf_dispatch` (запуск роли дочерней сессией), `tf_init`, `tf_standards` (индекс и выборочная загрузка стандартов). |
| **Команды** | `/tf-next`, `/tf-ship`, `/tf-review`, `/tf-handoff`, `/tf-status`, `/tf-plan`, `/tf-drive`, `/tf-milestone`, `/tf-init`, `/tf-doctor`, `/tf-discover`, `/tf-standards`, `/tf-shape`. |
| **Guard** | Статические правила по ролям + хук прав: правки защищённых путей (и по относительным, и по абсолютным путям в worktree) — только planner; `gh pr merge` и `gh api …/merge` — только reviewer и только в точной форме `gh pr merge <n> --squash --auto` / `--disable-auto`; никто не пушит в основную ветку и не переписывает историю (`--force`, `+refspec`, `HEAD:main`). Инструменты тоже по ролям: `tf_dispatch` — только lead и сессия человека, «пишущие» `tf_*` скрыты от reviewer и qa. |

**Граница гарантий.** Проверки shell-команд — по тексту команды (best effort): изменение файла через `sed -i` или
`echo > file` хук прав не видит. Жёсткий шлюз — защита ветки и обязательные проверки CI на GitHub; плагин делает
нарушения маловероятными и заметными, но не заменяет их.

Процесс целиком описан в контракте, который получает каждая роль (`src/roles.ts`, функция `contract`), и в
`.taskflow/workflow.md`, который создаёт `/tf-init` (или настроенном legacy-пути).

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

1. `/tf-init` — создаёт только `.taskflow/`: конфиг с найденными командами проверки/установки, workflow, доску задач,
   README эпиков, пустой индекс стандартов, руководство и шаблоны задач/эпиков/PR. Живого примера эпика нет.
   Существующие документы не перезаписываются. `AGENTS.md` и `.github/` по умолчанию не меняются.
2. Поправьте `.taskflow/config.jsonc` (команды проверки, обязательные CI-проверки, защищённые пути, области задач,
   env-файлы для worktree) и закоммитьте.
3. Для существующего проекта `/tf-discover api` помогает выявить и обсудить неявные соглашения. `/tf-standards` показывает индекс правил и помогает выбрать нужные. Если требования неясны, начните с `/tf-shape <функция>`, затем `/tf-plan E-01`: planner в своём worktree `plan/<slug>` раскладывает подтверждённый объём на задачи (PR на ревью человеку).
4. `/tf-next` — список готовых задач с рекомендацией. `/tf-next T-001` — захват задачи кодом (worktree, ветка,
   `in_progress`, claim-коммит), сессия переезжает в worktree и переключается на агента `implementer`.
   Или `/tf-drive` — оркестратор сам ведёт готовые задачи до слияния: implementer → reviewer → доработка
   (до `review.maxRounds` кругов) → ожидание слияния → `tf_clean` (он же подтягивает основную ветку).
5. `/tf-status` и `/tf-doctor` — состояние доски, PR, CI и какие модели выбраны для ролей.

## Конфигурация

Слои (каждый следующий важнее): встроенные значения → `~/.config/opencode/taskflow.jsonc` → конфиг проекта →
`options` плагина в `opencode.json`. Конфиг проекта: `.taskflow/config.jsonc`, при его отсутствии —
`.opencode/taskflow.jsonc`. Когда есть оба, старый проектный слой **не сливается**; `/tf-doctor` сообщает приоритет.
Объекты сливаются, массивы заменяются. Все пути процесса настраиваются в `paths`, индекс — в `standards.index`.

```jsonc
{
  "language": { "human": "ru", "agent": "en" },        // язык для человека и для агентских артефактов
  "git": { "remote": "origin", "baseBranch": null,      // null = определить (origin/HEAD, main, master)
           "branchPrefix": "task/", "worktreeDir": "../{repo}-wt" },
  "paths": { "tasks": ".taskflow/tasks", "epics": ".taskflow/epics", "board": ".taskflow/tasks/README.md", "template": ".taskflow/templates/task.md" },
  "task": { "areas": ["api", "web", "mobile", "infra", "docs"], "sizes": ["S", "M"], "idPadding": 3 },
  "setup": {                                             // выполняется в каждом новом worktree
    "copy": ["apps/api/.env", { "to": "apps/api/.env.test", "from": ["apps/api/.env.test", "apps/api/.env.test.example"] }],
    "commands": ["pnpm install --frozen-lockfile --prefer-offline"]
  },
  "verify": { "full": "pnpm verify", "quick": "pnpm verify:quick", "e2e": "pnpm e2e:smoke" },
  "ci": { "checks": ["verify", "contract", "e2e"] },
  "protected": ["docs/spec/**", "docs/decisions/**", ".taskflow/epics/**"],
  "qaPaths": ["e2e/**"],
  "standards": { "index": ".taskflow/standards/index.json", "roots": [".taskflow", "docs", "AGENTS.md"], "maxContextChars": 24000 },
  "spec": null,                                          // или { dir, definition, questions, questionPattern, acceptancePattern }
  "review": { "maxRounds": 3, "autoMerge": true, "mergeMethod": "squash" },
  "parallel": 2,                                         // максимум одновременных implementer'ов в /tf-drive
  "dispatch": { "timeoutMinutes": 180 },                 // дочерняя сессия прерывается по таймауту
  "agents": {                                            // цепочки: первая доступная модель побеждает
    "implementer": { "models": ["claude-code/claude-opus-5-5#medium", "anthropic/claude-opus-5-5#medium"] },
    "reviewer":    { "models": ["openai/gpt-6-astra#high", "claude-code/claude-opus-5-5#high"] },
    "qa":          { "disable": true }
    // также: name (id агента), model (одна модель; важнее цепочки models), permissions (доп. правила)
  },
  "categories": { "quick": { "models": ["claude-code/claude-sonnet-5-5#medium"] } },
  "routing": [ { "when": { "size": "S" }, "category": "quick" } ],   // модель implementer'а по размеру/области задачи
  "commandPrefix": "tf-"
}
```

### Расположение и совместимость

```text
.taskflow/
  config.jsonc
  workflow.md
  tasks/README.md           # доска; рядом T-NNN-slug.md
  epics/README.md           # рядом только настоящие E-NN-slug.md
  plans/<slug>/shape.md     # создаёт planner при уточнении требований
  standards/index.json     # пустой при init
  standards/README.md
  templates/task.md
  templates/epic.md         # шаблон, не живой эпик
  templates/pull-request.md
  templates/human-review.md
```

Всё состояние процесса хранится в Git проекта. `paths` также включает `workflow`, `plans`, `standardsGuide`,
`epicTemplate`, `prTemplate`, `humanReviewTemplate`, `milestones`. `paths.config` — эффективный путь обнаруженного
проектного конфига, а не способ перенести его через глобальную настройку.

Legacy-проектный конфиг сохраняет старые defaults и явные переопределения. Без конфига legacy определяется только
по workflow с маркером `opencode-taskflow` либо finance-сигнатуре: board с `scripts/tasks.mjs`, сам скрипт и
`tasks/_template.md`. Одних папок `tasks/` и `epics/` недостаточно. Явные глобальные legacy paths
(`tasks: "tasks"` плюс `epics: "epics"` или `template: "tasks/_template.md"`) также сохраняются.
Повторный init не переносит файлы и не создаёт вторую раскладку; legacy PR-шаблоны по умолчанию лежат в
`docs/taskflow-templates/`. Для будущей миграции сначала согласуйте инвентаризацию путей и отдельный план перемещений,
затем явно одобрите изменения. Автоматической миграции нет.

Если в legacy-проекте уже есть `.github/pull_request_template.md` и/или
`.github/PULL_REQUEST_TEMPLATE/human-review.md`, роли читают существующий соответствующий шаблон сразу, без init
или записи файлов. Явные `paths.prTemplate`/`paths.humanReviewTemplate` важнее этой совместимой подстановки.
Новые central-проекты остаются на `.taskflow/templates/` независимо от наличия GitHub-шаблонов.

Перед первой записью init проверяет **все** целевые файлы, включая доску и включённые интеграции: относительные
переносимые пути, отсутствие выхода через существующие symlink, коллизий и несовместимых типов/файлов-родителей.
Ошибка оставляет файловую систему без частичного scaffold. Существующая доска тоже сохраняется; для явной
перегенерации используйте `tf_board`. Это защита от заранее существующего состояния ФС, не sandbox против гонок.

Спецификации, ADR и существующие AGENTS/CLAUDE остаются каноническими на своих местах; init их не копирует и не переносит.
Необязательные интеграции доступны только явно: `tf_init` с `agentsLink: true` добавляет workflow-ссылку в AGENTS.md
(сохраняя текст), `githubTemplate: true` добавляет отсутствующий `.github/PULL_REQUEST_TEMPLATE/human-review.md`.
Существующий GitHub-шаблон никогда не заменяется.

Полные значения по умолчанию — `defaultConfig()` в `src/config.ts`. Неверные значения (не тот тип, неизвестный
`mergeMethod`, битое регулярное выражение в `spec`) заменяются значениями по умолчанию по одному полю, а проблема
видна в `/tf-doctor`. Файлы конфига перечитываются при изменении, роли перерегистрируются автоматически.

### Модели

Как в oh-my-openagent, но без зашитого каталога провайдеров: цепочка — обычный конфиг, доступность берётся из реестра
моделей OpenCode. Вариант, которого у модели нет, отбрасывается (модель остаётся) — это видно в `/tf-doctor`.
По умолчанию reviewer предпочитает другое семейство моделей, чем implementer (перекрёстное ревью ловит больше).
Если ни одна модель цепочки недоступна, роль наследует модель сессии.

### Переопределение ролей файлами

Файл `.opencode/agents/<role>.md` в проекте побеждает плагин по каждому полю, которое в нём задано (например, свой
промпт), а незаданные поля (модель, права) остаются от плагина. Так подключаются проекты, у которых уже есть свои
агенты. Guard-хук действует в любом случае.

## Стандарты и уточнение требований

Идеи Agent OS v3 адаптированы к нашему процессу без установки Agent OS и без копирования его реализации:

- **`/tf-discover [область]`** — изучить код и тесты, собрать примеры и исключения, спросить причину решений. Наблюдения не становятся правилами автоматически: planner оформляет изменения после явного подтверждения человека, PR сливает человек.
- **`/tf-standards [запрос или id]`** — найти подходящие правила по индексу, затем загрузить только явно выбранные. Это ссылки на существующие `AGENTS.md`, спецификации и ADR, а не вторая копия требований.
- **`/tf-shape <функция>`** — уточнить цель, не-цели, примеры, крайние случаи и проверяемую приёмку. Planner сохраняет `.taskflow/plans/<slug>/shape.md` (или `paths.plans`) с открытыми вопросами и статусом подтверждения; до решения блокирующих вопросов не начинает реализацию.

`/tf-init` создаёт пустой индекс и руководство, не перезаписывая существующие документы. Старые задачи без `standards` работают как раньше. Новая задача может содержать `standards: [api-errors]`: `tf_check` проверяет привязку, а `tf_dispatch` передаёт исполнителю и ревьюеру выбранные источники из worktree задачи с путями и SHA-256. Автоматического выбора по подсказке нет.

**Важно:** `status: "approved"` — локальные метаданные процесса, не подпись и не доказательство личности одобрившего. Источники перечитываются при каждом dispatch: между запусками они могут измениться, поэтому сравнивайте контрольные суммы в отчётах. Ошибочная или черновая привязка останавливает dispatch до запуска дочерней сессии. Превышение бюджета — явная ошибка, не молчаливая обрезка.

Формат индекса, примеры и ограничения: [docs/STANDARDS.md](docs/STANDARDS.md).

## Разработка

```bash
bun install
bun run check        # tsc + bun test
bash scripts/e2e.sh  # загрузка в реальный OpenCode и проверка через API (см. скрипт)
```

Архитектура и решения — `docs/ARCHITECTURE.md`. Планы — `docs/ROADMAP.md`.
