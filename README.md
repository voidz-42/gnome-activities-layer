# Activities Layer

Extensão do GNOME Shell 50 que cria **Atividades** acima dos workspaces:
"Trabalho", "Estudos"... Cada Atividade tem as próprias janelas e os próprios
workspaces (dinâmicos). Só uma fica ativa por vez. As janelas das outras somem
da tela, da Visão Geral, do seletor de workspaces, do Alt+Tab/Super+Tab e do
dash.

Feito e testado em Fedora 44, GNOME Shell 50.6 e Mutter 50.6, sessão Wayland.

## Instalação

```bash
./install.sh
```

O script cria symlinks deste repositório em
`~/.local/share/gnome-shell/extensions/activities-layer@local` e de
`bin/activity` em `~/.local/bin/`. Também copia as receitas de exemplo para
`~/.config/activities-layer/recipes/` sem sobrescrever nada, e habilita a
extensão.

**No Wayland o Shell só descobre extensões novas no login: saia da sessão e
entre de novo.** Depois de editar o código, é preciso relogar também.

| Comando | O que faz |
|---|---|
| `./install.sh --pack` | Gera `dist/activities-layer@local.shell-extension.zip`, o pacote para a extensions.gnome.org |
| `./install.sh --uninstall` | Remove os symlinks; as receitas e o estado ficam |
| `gnome-extensions prefs activities-layer@local` | Abre as preferências |

## Uso

### Atalhos padrão

Todos podem ser trocados em Preferências › Atalhos. Backspace desativa um
atalho.

| Ação | Atalho |
|---|---|
| Próxima / anterior Atividade | `Super+Ctrl+Alt+↓` / `Super+Ctrl+Alt+↑` |
| Ir para a Atividade 1…9 | `Super+Ctrl+Alt+1…9` |
| Nova Atividade (e ir para ela) | `Super+Ctrl+Alt+N` |
| Mover a janela focada para a próxima / anterior | `Shift+Super+Ctrl+Alt+↓` / `↑` |
| Mover a janela focada para a Atividade 1…9 | `Shift+Super+Ctrl+Alt+1…9` |

As setas para cima e para baixo acompanham a animação vertical: ↓ vai para a
próxima Atividade, que entra por baixo. O prefixo `Super+Ctrl+Alt` foi escolhido porque os outros já são usados no
GNOME 50: `Super+Ctrl+1…9` troca de workspace, `Super+Alt+8` liga a lupa e
`Super+Alt+↑/↓` move a Visão Geral.

### Indicador no painel

Fica à esquerda e mostra a Atividade atual. O menu permite:

- trocar de Atividade (o número ao lado é a quantidade de janelas);
- criar, renomear ou remover Atividades;
- mover a janela focada para outra Atividade;
- abrir as preferências.

### Aparência

Fica no menu do indicador no painel e em Preferências › Activities (seção
Appearance, logo abaixo da lista).

- **Ícone por Atividade:** no menu do painel, "Icon of “…”" abre uma grade de
  ícones para a Atividade atual. Em Preferências › Activities, clique no
  ícone redondo à esquerda do nome de qualquer Atividade. Dá para escolher um dos ícones simbólicos do tema ou
  digitar qualquer nome de ícone instalado. O ícone aparece no painel, no menu
  e no aviso de troca.
  - Pelo terminal: `activity icon Trabalho applications-engineering-symbolic`.
  - Para voltar ao padrão: `activity icon Trabalho ""`.
  - Numa receita: `icon = "..."`.
- **Só o ícone no painel:** desligue "Show Name in Top Bar" no menu do painel
  ou "Show Activity Name in the Top Bar" nas preferências (chave
  `show-indicator-label`).
- **Animação de troca** (chave `switch-animation`):

  | Opção | Efeito |
  |---|---|
  | Vertical Slide (padrão) | As janelas da Atividade anterior saem por cima (ou por baixo, ao voltar) e as da nova entram pelo lado oposto. O fundo fica parado. |
  | GNOME Workspace Slide | O deslize horizontal do GNOME, que só toca quando o workspace ativo muda. |
  | None | Troca instantânea. |

  As animações respeitam a configuração "Animações" do GNOME e não tocam com
  a Visão Geral aberta.

### Comportamento

- **Janelas novas** vão para a Atividade que estava ativa quando foram
  criadas. A exceção são as janelas "reivindicadas" por uma receita (ver
  abaixo).
- **Atividade nova:** começa limpa, com um workspace vazio. O GNOME sempre
  mantém pelo menos 2 workspaces: o atual e um vazio no fim.
- **Ao voltar** para uma Atividade, as janelas retornam ao mesmo workspace. O
  workspace ativo e a janela focada também são restaurados.
- **Remover uma Atividade** não fecha nada. As janelas dela vão para a
  Atividade ativa.
- **Janelas em todos os workspaces** (menu da janela › "Sempre na área de
  trabalho visível") são globais: aparecem em todas as Atividades.
- **Janela escondida ativada** por uma notificação, pelo próprio app ou por
  D-Bus: troca para a Atividade dela, como o GNOME faz com workspaces. Isso
  pode ser desligado em Preferências › Comportamento.
- **Apps do dash:** um app cujas janelas estão todas em outra Atividade não
  aparece como "em execução". Clicar nele abre uma janela nova aqui.
- **Persistência:**
  - `~/.config/activities-layer/state.json` guarda nomes, ordem e a Atividade
    atual.
  - `$XDG_RUNTIME_DIR/activities-layer/session.json` guarda o mapa
    janela → Atividade enquanto a sessão durar. Assim ele sobrevive a
    desativar e reativar a extensão.
  - As janelas não são restauradas depois do logout.

## CLI `activity`

```bash
activity list                  # Atividades (* = atual) e nº de janelas
activity current
activity switch Trabalho       # ou: activity switch 2   |  --create para criar se faltar
activity new "Estudos"         # cria e troca (--no-switch para só criar)
activity rename Estudos Faculdade
activity rm Faculdade          # janelas vão para a Atividade ativa
activity windows [Atividade]   # ids, WM_CLASS/app id, workspace, escondida?
activity move 123456 Trabalho  # move a janela de id 123456
activity recipes               # lista as receitas
activity run trabalho          # roda ~/.config/activities-layer/recipes/trabalho.toml
activity run trabalho --no-switch   # abre tudo lá sem sair de onde você está
```

O CLI só usa a biblioteca padrão do Python 3.11+ (`tomllib`) e o `gdbus`.

### Receitas

Uma receita é um arquivo `~/.config/activities-layer/recipes/<nome>.toml`.
Exemplos: [`recipes/trabalho.toml`](recipes/trabalho.toml) e
[`recipes/estudos.toml`](recipes/estudos.toml).

```toml
activity = "Trabalho"      # obrigatório; criada se não existir
icon = "applications-engineering-symbolic"   # opcional
switch = true              # trocar para ela (padrão true)
switch_first = true        # trocar antes de abrir os apps (padrão true)
timeout = 30               # segundos esperando cada janela (padrão 30)

[[launch]]
command = ["flatpak", "run", "app.zen_browser.zen", "--new-window", "https://exemplo.com"]
match = "zen"              # trecho do app id / WM_CLASS (padrão: nome do executável)
workspace = 0              # workspace da Atividade, a partir de 0 (padrão: não mexe)
windows = 1                # quantas janelas esperar (0 = não esperar)
sequential = false         # true = só lança o próximo depois desta janela aparecer
```

`command` pode ser uma lista ou uma string (dividida como no shell). `~` e
`$VAR` são expandidos. Para descobrir o `match` de um app, abra-o e rode
`activity windows`.

Os formatos aceitos são só TOML. YAML exigiria uma dependência fora da
biblioteca padrão.

#### Por que a janela cai na Atividade certa, mesmo com Firefox ou VS Code

Firefox, Zen e VS Code reaproveitam um processo que já está rodando: o comando
que a receita executa só repassa o pedido e sai. Por isso o pid não serve para
achar a janela. A solução adotada é uma **reivindicação**:

1. **Antes** de lançar o comando, o CLI chama
   `ExpectWindow(atividade, match, workspace, n, timeout)`. A extensão anota:
   "as próximas *n* janelas cujo app id/WM_CLASS contém `match` são desta
   Atividade".
2. No sinal `window-created`, a extensão confere as reivindicações pendentes
   **antes** de usar a Atividade ativa. A janela vai para a Atividade da
   receita e o workspace pedido, mesmo que você tenha trocado de Atividade
   enquanto o app abria.
3. No Wayland a janela nasce antes de o app informar o próprio id
   (`xdg_toplevel.set_app_id`). Se há reivindicação pendente, a janela fica
   **invisível** (`inhibit_mapped`) até o id chegar, por no máximo 1,5 s.
   Assim ela nunca aparece na Atividade errada.
4. O CLI acompanha o andamento com `GetClaim(id)`. Uma reivindicação expira
   no timeout.

Limites dessa abordagem:

- Se o app não cria uma janela nova (por exemplo, abre só uma aba numa
  janela existente), não há o que reivindicar e o pedido expira. Use
  `--new-window`.
- Uma janela do mesmo app que você abrir manualmente durante a espera também
  pode ser reivindicada.
- Com duas reivindicações para o mesmo `match`, quem chega primeiro fica com a
  primeira.

### Autostart (exemplo, desativado)

O arquivo [`autostart/activity-recipe-trabalho.desktop`](autostart/activity-recipe-trabalho.desktop)
roda `activity run trabalho --no-switch --wait 60` no login. Para usar,
copie-o para `~/.config/autostart/` e troque `X-GNOME-Autostart-enabled` para
`true` e `Hidden` para `false`. O `--wait` espera a extensão ficar pronta.

## API D-Bus

Fica no nome `org.gnome.Shell`, caminho
`/org/gnome/Shell/Extensions/ActivitiesLayer`, interface
`org.gnome.Shell.Extensions.ActivitiesLayer`. Qualquer processo da sua sessão
pode chamar.

| Método | Retorno |
|---|---|
| `ListActivities()` | `as` nomes, na ordem |
| `GetCurrent()` | `s` |
| `SwitchActivity(s name)` | `b` |
| `CreateActivity(s name)` | `s` nome criado (`''` gera "Activity N") |
| `RemoveActivity(s name)` | `b` |
| `RenameActivity(s name, s new_name)` | `b` |
| `MoveActivity(s name, i position)` | `b` |
| `MoveWindowToActivity(t window_id, s name)` | `b` |
| `SetActivityIcon(s name, s icon)` | `b` (`''` volta ao ícone padrão) |
| `GetState()` | `s` JSON: Atividades, ícone, atual, nº de janelas |
| `ListWindows()` | `s` JSON: id, título, wm_class, app_id, Atividade, workspace, hidden… |
| `ExpectWindow(s activity, s match, i workspace, u count, u timeout_ms)` | `u` id da reivindicação |
| `GetClaim(u id)` | `s` JSON: matched, remaining, expired, done |

| Sinal | Argumentos |
|---|---|
| `ActivityChanged` | `s current, s previous` |
| `ActivitiesChanged` | nenhum |

Exemplos:

```bash
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/ActivitiesLayer \
  --method org.gnome.Shell.Extensions.ActivitiesLayer.SwitchActivity "Trabalho"

gdbus monitor --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/ActivitiesLayer
```

## Como funciona

O Mutter não tem workspace oculto nem grupos de janelas. O Mutter 50, porém,
expõe duas primitivas que resolvem quase tudo:

- **`Meta.Window.inhibit_mapped()`** desmapeia a janela **sem minimizá-la**.
  Ela não é desenhada, não recebe foco nem entrada, e o app não é avisado de
  que foi minimizado. O estado "minimizada" que você escolheu fica intacto.
- **`Meta.Window.hide_from_window_list()`** força `skip-taskbar`. O Shell já
  respeita essa flag:
  - na Visão Geral e nas miniaturas;
  - no Alt+Tab e no Super+Tab;
  - no `ShellApp`: um app sem janelas "interessantes" fica `STOPPED`, então
    sai do dash e o clique abre uma janela nova.

O rastreador de workspaces dinâmicos conta toda janela que não está em todos
os workspaces. Por isso as janelas escondidas também recebem `stick()`, e o
GNOME recolhe sozinho os workspaces da Atividade inativa. Na volta, cada
janela recebe `unstick()` e é movida de volta ao índice salvo.

Patches no Shell, todos via `InjectionManager` e desfeitos no `disable()`:

1. `workspaceAnimation.WorkspaceAnimationController.animateSwitch`: durante
   uma troca de Atividade, pula o deslize horizontal do GNOME, a menos que a
   opção "GNOME Workspace Slide" esteja escolhida.
2. `altTab.GroupCyclerPopup._getWindows`: o ciclo entre janelas do mesmo app
   (Alt+\`) usa `app.get_windows()` sem olhar `skip-taskbar`.
3. `workspace.Workspace._doAddWindow` e `_doRemoveWindow`: contornam um
   vazamento de handlers `notify::skip-taskbar` no Shell 50. Sem isso, uma
   janela `skip-taskbar` adicionada várias vezes ao mesmo workspace deixa
   handlers que disparam depois em atores destruídos.

A extensão também roda na tela de bloqueio (`session-modes`:
`unlock-dialog`). Sem isso, o GNOME a desativaria ao bloquear, mostrando e
escondendo de novo todas as janelas de todas as Atividades. Bloqueado, o
indicador sai e os atalhos ficam inativos.

## Testes

```bash
tests/nested.sh                        # suíte completa, shell headless isolado
tests/nested.sh --zip dist/*.zip       # idem, instalando o pacote .zip
tests/nested.sh --with-user-extensions # junto com as suas outras extensões
AL_SHOTS=/tmp/shots tests/nested.sh    # salva capturas de tela
AL_SECOND_MONITOR=1 AL_TEST_SCRIPT=$PWD/tests/multimonitor.py tests/nested.sh
AL_FORCE_ANIMATIONS=1 AL_TEST_SCRIPT=$PWD/tests/visual.py tests/nested.sh   # ícones, rótulo, animações
tests/nested.sh --shell                # bash dentro do ambiente, para explorar
```

O `nested.sh` roda tudo isolado da sua sessão:

- `dbus-run-session` com um barramento D-Bus próprio;
- `XDG_*` temporários, então dconf, extensões habilitadas e `state.json` reais
  não são tocados;
- `gnome-shell --headless --virtual-monitor`, sem nenhuma janela na tela.

A extensão auxiliar `tests/helper` liga o "unsafe mode" **só nesse ambiente**,
para o teste inspecionar a Visão Geral, o Alt+Tab e o dash via
`org.gnome.Shell.Eval`. O teste abre janelas GTK reais
([`tests/testwin.py`](tests/testwin.py)) e verifica:

- troca de Atividade e restauração de workspaces;
- o que aparece na tela, no Overview, nas miniaturas, no Alt+Tab, no
  Super+Tab e no dash;
- mover janelas;
- reivindicações, com app lento e com processo reaproveitado;
- ativação de janela escondida;
- atalhos (teclado virtual), indicador e preferências;
- CLI e receitas;
- tela de bloqueio;
- 3 ciclos de desativar e ativar.

Para ver um shell aninhado com janela (GNOME 49+), é preciso o pacote
`mutter-devkit`, que não é instalado por padrão no Fedora:
`sudo dnf install mutter-devkit`, depois
`dbus-run-session gnome-shell --devkit --wayland`.

### Roteiro de teste manual (sessão real)

1. Abra 2 ou 3 janelas e espalhe-as em dois workspaces. Rode
   `activity new Teste`: a tela fica vazia e o indicador mostra "Teste".
2. Confira que nenhuma janela antiga aparece na Visão Geral (Super), nas
   miniaturas de workspaces, no Alt+Tab, no Super+Tab nem como "em execução"
   no dash.
3. Abra um app aqui e mude-o para o segundo workspace (Super+Shift+Page Down).
4. Faça `Super+Ctrl+Alt+↑`: as janelas originais voltam aos mesmos
   workspaces, e o workspace ativo é o mesmo de antes.
5. Use `Super+Ctrl+Alt+1` e `2`, e o menu do painel, para alternar. Confira
   que a janela focada é restaurada.
6. Mova uma janela com `Shift+Super+Ctrl+Alt+2`: ela some daqui e aparece em
   "Teste".
7. Em "Teste", rode `activity run trabalho --no-switch` e troque de Atividade
   na hora. As janelas devem aparecer em "Trabalho", não onde você está
   (`activity windows`).
8. Receba uma notificação de um app que está em outra Atividade e clique
   nela: a Atividade troca.
9. Bloqueie a tela (Super+L) e desbloqueie: nada de outras Atividades deve
   aparecer.
10. Rode `gnome-extensions disable activities-layer@local`: todas as janelas
    reaparecem, cada Atividade em workspaces ao final. Rode `enable`: elas
    voltam a se esconder como antes.
11. Acompanhe os logs com `journalctl -f -o cat /usr/bin/gnome-shell | grep -i activities`.

## Limitações e o que é frágil

Os detalhes de implementação estão comentados em [`lib/manager.js`](lib/manager.js).

- **APIs recentes do Mutter:** `inhibit_mapped` e `hide_from_window_list`
  existem no Mutter 50, mas o próprio GNOME Shell não as usa. A semântica
  pode mudar.
- **Comportamento do Shell:** o esconder depende de o Shell respeitar
  `skip-taskbar` na Visão Geral, no Alt+Tab e no `ShellApp`. Isso é estável
  há anos, mas não é contrato.
- **Patches em código interno do Shell 50:** `_getWindows`, `_doAddWindow`,
  `_doRemoveWindow`, `_skipTaskbarSignals` e `_isMyWindow`. Podem mudar de
  nome em qualquer versão.
- **Janelas escondidas ficam "em todos os workspaces"** (`stick`). Outras
  extensões (listas de janelas, docks) que não olham `skip-taskbar` podem
  mostrá-las.
- **Ativação detectada por `notify::user-time`:** é uma heurística. O Mutter
  não foca uma janela desmapeada, mas atualiza o user time quando ela é
  ativada.
- **Workspaces fixos** (dinâmicos desligados) não foram testados.
- **Monitores secundários** com "workspaces só no principal": as janelas são
  escondidas e restauradas, mas uma janela "sempre visível" num monitor
  secundário não pode ser distinguida e passa a pertencer a uma Atividade.
- **Animação vertical:** usa clones de janelas já escondidas. Funciona porque o
  Clutter continua pintando o clone de um ator desmapeado, o mesmo mecanismo
  que mostra janelas minimizadas na Visão Geral. Se um app descartar o buffer
  da janela ao ser escondido, ela pode sumir em vez de deslizar.
- **Apps X11 (XWayland):** devem funcionar, mas o teste automático roda sem
  XWayland.
