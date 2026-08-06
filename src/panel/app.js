import { clear, h } from "@/lib/dom";
import { icon } from "@/lib/icons";
import { providerIcon } from "@/lib/provider-icons";
import { activeCwd, shortPath } from "@/lib/cwd";
import {
  getArchivedSessions,
  getListFilter,
  getPreferredCli,
  getShowArchived,
  setListFilter,
  setPreferredCli,
  setShowArchived,
} from "@/lib/storage";
import { openResumeTerminal, openStartTerminal } from "@/lib/resume";
import { filterGroups, listAll, pickStartCli } from "@/lib/sessions/index";
import { dateGroup, relativeTime } from "@/lib/time";
import { groupByDate } from "@/lib/sessions/group";
import { archiveSession, deleteSession, renameSession } from "@/lib/sessions/manage";
import { providerById } from "@/lib/sessions/providers";
import {
  editTargetStillPresent,
  evaluateRenameDraft,
  findSessionByKey,
  sessionRowKey,
} from "@/lib/sessions/inline-rename";

function basenamePath(path) {
  if (!path || typeof path !== "string") return null;
  const norm = path.replace(/[\\/]+$/, "");
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/** Attribute-safe form of sessionRowKey for data-* selectors (avoid CSS.escape). */
function dataKeyAttr(key) {
  return String(key).replace(/:/g, "__");
}

export class SessionsPanel {
  constructor(root) {
    this.root = root;
    this.cwd = null;
    this.installed = [];
    this.groups = [];
    this.filter = "all";
    this.preferredCli = "grok";
    this.loading = true;
    this.error = null;
    this.busyId = null;
    this.showArchived = false;
    this.archivedSet = new Set();
    this.pythonMissing = false;
    this.editingKey = null;
    this.editDraft = "";
    this.editError = null;
    this.confirmingDeleteKey = null;
    this._pendingFocus = null;
    this._lastEditedKey = null;
  }

  clearEditState() {
    this.editingKey = null;
    this.editDraft = "";
    this.editError = null;
  }

  clearInlineModes() {
    this.clearEditState();
    this.confirmingDeleteKey = null;
  }

  async start() {
    this.preferredCli = await getPreferredCli();
    this.filter = await getListFilter();
    this.showArchived = await getShowArchived();
    this.archivedSet = await getArchivedSessions();

    muxy.events.subscribe("command.refresh-sessions", () => this.refresh());
    muxy.events.subscribe("project.switched", () => this.refresh());
    muxy.events.subscribe("worktree.switched", () => this.refresh());

    await this.refresh();
  }

  async refresh() {
    this.clearInlineModes();
    this._pendingFocus = null;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      this.cwd = await activeCwd();
      this.archivedSet = await getArchivedSessions();
      const { installed, groups, pythonMissing, errorsByCli } = await listAll(this.cwd, {
        archivedSet: this.archivedSet,
      });
      this.installed = installed;
      this.groups = groups;
      this.pythonMissing = Boolean(pythonMissing);
      if (this.pythonMissing && errorsByCli?._python) {
        this.error = errorsByCli._python;
      }
      if (this.filter !== "all" && !installed.some((p) => p.id === this.filter)) {
        this.filter = "all";
        await setListFilter("all");
      }
      if (this.editingKey && !editTargetStillPresent(this.editingKey, this.groups)) {
        this.clearEditState();
      }
      if (
        this.confirmingDeleteKey &&
        !editTargetStillPresent(this.confirmingDeleteKey, this.groups)
      ) {
        this.confirmingDeleteKey = null;
      }
    } catch (err) {
      this.error = err?.message || String(err);
      this.installed = [];
      this.groups = [];
      this.pythonMissing = false;
      this.clearInlineModes();
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async setFilter(filter) {
    this.clearInlineModes();
    this._pendingFocus = null;
    this.filter = filter;
    await setListFilter(filter);
    this.render();
  }

  async resume(session) {
    if (this.editingKey || this.confirmingDeleteKey) {
      this.clearInlineModes();
      this._pendingFocus = null;
    }
    this.busyId = sessionRowKey(session.cli, session.id);
    this.render();
    try {
      await openResumeTerminal(session.cli, session.id);
      if (session.cli !== this.preferredCli) {
        this.preferredCli = session.cli;
        await setPreferredCli(session.cli);
      }
    } catch (err) {
      try {
        await muxy.notifications.notify({
          title: "Could not resume session",
          body: err?.message || String(err),
        });
      } catch {
        // notifications optional
      }
    } finally {
      this.busyId = null;
      this.render();
    }
  }

  async startNew() {
    const cli = pickStartCli(this.preferredCli, this.installed);
    if (!cli) return;
    try {
      await openStartTerminal(cli);
    } catch (err) {
      try {
        await muxy.notifications.notify({
          title: "Could not start session",
          body: err?.message || String(err),
        });
      } catch {
        /* ignore */
      }
    }
  }

  async toggleShowArchived() {
    this.clearInlineModes();
    this._pendingFocus = null;
    this.showArchived = !this.showArchived;
    await setShowArchived(this.showArchived);
    this.render();
  }

  beginRename(session) {
    if (this.busyId) return;
    const key = sessionRowKey(session.cli, session.id);
    this.confirmingDeleteKey = null;
    this.editingKey = key;
    this.editDraft = session.title ?? "";
    this.editError = null;
    this._pendingFocus = "input";
    this.render();
  }

  cancelRename() {
    if (this.editingKey) this._lastEditedKey = this.editingKey;
    this.clearEditState();
    this._pendingFocus = "row";
    this.render();
  }

  beginDelete(session) {
    if (this.busyId) return;
    const key = sessionRowKey(session.cli, session.id);
    this.clearEditState();
    this.confirmingDeleteKey = key;
    this._lastEditedKey = key;
    this._pendingFocus = "delete-confirm";
    this.render();
  }

  cancelDelete() {
    if (this.confirmingDeleteKey) this._lastEditedKey = this.confirmingDeleteKey;
    this.confirmingDeleteKey = null;
    this._pendingFocus = "row";
    this.render();
  }

  async confirmDelete() {
    if (!this.confirmingDeleteKey || this.busyId) return;
    const key = this.confirmingDeleteKey;
    const session = findSessionByKey(key, this.groups);
    if (!session) {
      this.confirmingDeleteKey = null;
      this.render();
      return;
    }
    this.busyId = key;
    this.render();
    try {
      await deleteSession(session.cli, session.id, this.cwd);
      this._lastEditedKey = key;
      this.confirmingDeleteKey = null;
      this.busyId = null;
      await this.refresh();
    } catch (err) {
      try {
        await muxy.notifications.notify({
          title: "Could not delete session",
          body: err?.message || String(err),
        });
      } catch {
        /* ignore */
      }
      this.busyId = null;
      this._pendingFocus = "delete-confirm";
      this.render();
    }
  }

  async confirmRename() {
    if (!this.editingKey || this.busyId) return;
    const key = this.editingKey;
    const session = findSessionByKey(key, this.groups);
    if (!session) {
      this.clearEditState();
      this.render();
      return;
    }
    const result = evaluateRenameDraft(session.title, this.editDraft);
    if (result.action === "empty") {
      this.editError = null;
      this._pendingFocus = "input";
      this.render();
      return;
    }
    if (result.action === "unchanged") {
      this.cancelRename();
      return;
    }

    this.busyId = key;
    this.editError = null;
    this.render();
    try {
      await renameSession(session.cli, session.id, result.title);
      this._lastEditedKey = key;
      this.clearEditState();
      this.busyId = null;
      await this.refresh();
      this._pendingFocus = "row";
      this.render();
    } catch (err) {
      try {
        await muxy.notifications.notify({
          title: "Could not rename session",
          body: err?.message || String(err),
        });
      } catch {
        /* ignore */
      }
      this.busyId = null;
      this._pendingFocus = "input";
      this.render();
    }
  }

  async archive(session) {
    this.clearInlineModes();
    const newArchived = !session.archived;
    const key = sessionRowKey(session.cli, session.id);
    this.busyId = key;
    this.render();
    try {
      await archiveSession(session.cli, session.id, newArchived);
      this.archivedSet = await getArchivedSessions();
      const { groups } = await listAll(this.cwd, { archivedSet: this.archivedSet });
      this.groups = groups;
    } catch (err) {
      try {
        await muxy.notifications.notify({
          title: newArchived ? "Could not archive session" : "Could not unarchive session",
          body: err?.message || String(err),
        });
      } catch {
        /* ignore */
      }
    } finally {
      this.busyId = null;
      this.render();
    }
  }

  render() {
    clear(this.root);
    this.root.appendChild(this.view());
    this._applyPendingFocus();
  }

  _applyPendingFocus() {
    const intent = this._pendingFocus;
    this._pendingFocus = null;
    if (intent === "input" && this.editingKey) {
      const input = this.root.querySelector(
        `input[data-edit-key="${dataKeyAttr(this.editingKey)}"]`,
      );
      if (input) {
        input.focus();
        input.select();
      }
      return;
    }
    if (intent === "delete-confirm" && this.confirmingDeleteKey) {
      const btn = this.root.querySelector(
        `button[data-delete-confirm="${dataKeyAttr(this.confirmingDeleteKey)}"]`,
      );
      btn?.focus();
      return;
    }
    if (intent === "row") {
      const key = this._lastEditedKey;
      if (!key) return;
      const btn = this.root.querySelector(
        `button[data-session-key="${dataKeyAttr(key)}"]`,
      );
      btn?.focus();
    }
  }

  view() {
    const allVisible = filterGroups(this.groups, this.filter);
    // Apply archived filter: unless showArchived is on, hide archived sessions
    const visible = allVisible.map((g) => ({
      ...g,
      sessions: this.showArchived ? g.sessions : g.sessions.filter((s) => !s.archived),
    })).filter((g) => g.sessions.length || g.error);
    const flat =
      this.filter !== "all"
        ? visible.flatMap((g) => g.sessions)
        : null;

    return h(
      "div",
      { class: "flex h-full flex-col" },
      this.toolbar(),
      h(
        "div",
        { class: "px-2.5 pb-1.5 text-[10px] text-muted-foreground truncate" },
        this.cwd ? shortPath(this.cwd, 56) : "No active project",
      ),
      h(
        "div",
        { class: "min-h-0 flex-1 overflow-y-auto px-1 pb-2" },
        this.loading
          ? this.emptyState("Loading sessions…")
          : this.error
            ? this.emptyState(this.error)
            : !this.installed.length
              ? this.noCliState()
              : this.filter === "all"
                ? this.groupedBody(visible)
                : this.flatBody(flat, visible[0]),
      ),
      this.footer(),
    );
  }

  toolbar() {
    const chips = [
      { id: "all", label: "All", providerId: null },
      ...this.installed.map((p) => ({ id: p.id, label: p.displayName, providerId: p.id })),
    ];

    const hasArchived = this.groups.some((g) => g.sessions.some((s) => s.archived));

    return h(
      "div",
      { class: "flex flex-wrap items-center gap-1 px-2.5 pt-2.5 pb-1" },
      ...chips.map((chip) =>
        h(
          "button",
          {
            type: "button",
            "aria-pressed": this.filter === chip.id ? "true" : "false",
            class:
              this.filter === chip.id
                ? "inline-flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground outline-none"
                : "inline-flex h-6 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none hover:bg-accent",
            onclick: () => this.setFilter(chip.id),
          },
          chip.providerId ? providerIcon(chip.providerId, 12) : null,
          chip.label,
        ),
      ),
      (hasArchived || this.showArchived)
        ? h(
            "button",
            {
              type: "button",
              class: this.showArchived
                ? "ml-auto h-6 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground outline-none"
                : "ml-auto h-6 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none hover:bg-accent",
              onclick: () => this.toggleShowArchived(),
            },
            icon("archive", 10),
            " Archived",
          )
        : null,
    );
  }

  groupedBody(groups) {
    if (!groups.length) {
      return this.emptyState("No resumable sessions for this folder", true);
    }
    const errors = groups.filter((g) => g.error);
    const allSessions = groups
      .flatMap((g) => g.sessions)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const dateGroups = groupByDate(allSessions, dateGroup);
    return h(
      "div",
      { class: "flex flex-col gap-1" },
      ...errors.map((g) =>
        h(
          "div",
          { class: "px-2 py-1 text-[11px] text-muted-foreground" },
          `${g.displayName}: ${g.error}`,
        ),
      ),
      ...dateGroups.map(({ label, sessions }) =>
        this.dateSection(label, sessions),
      ),
    );
  }

  flatBody(sessions, group) {
    if (group?.error && !sessions?.length) {
      return this.emptyState(group.error);
    }
    if (!sessions?.length) {
      return this.emptyState("No resumable sessions for this folder", true);
    }
    const dateGroups = groupByDate(sessions, dateGroup);
    return h(
      "div",
      { class: "flex flex-col" },
      group?.error
        ? h(
            "div",
            { class: "px-2 py-1 text-[11px] text-muted-foreground" },
            group.error,
          )
        : null,
      ...dateGroups.map(({ label, sessions: dateSessions }) =>
        this.dateSection(label, dateSessions),
      ),
    );
  }

  dateSection(label, sessions) {
    return h(
      "div",
      { class: "flex flex-col" },
      h(
        "div",
        {
          class:
            "sticky top-0 z-10 flex items-center justify-between bg-background px-2 py-1",
        },
        h(
          "span",
          {
            class:
              "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
          },
          label,
        ),
        h(
          "span",
          { class: "font-mono text-[10px] text-muted-foreground" },
          String(sessions.length),
        ),
      ),
      ...sessions.map((s) => this.row(s)),
    );
  }

  row(session) {
    const key = sessionRowKey(session.cli, session.id);
    const dataKey = dataKeyAttr(key);
    const busy = this.busyId === key;
    const isEditing = this.editingKey === key;
    const isConfirmingDelete = this.confirmingDeleteKey === key;
    const cwdBase = basenamePath(session.cwd);
    const place = [cwdBase, session.branch].filter(Boolean).join(" · ");
    const secondary = [relativeTime(session.updatedAt), place].filter(Boolean).join(" · ");

    const caps = providerById(session.cli)?.capabilities ?? {};

    if (isConfirmingDelete) {
      return h(
        "div",
        {
          class: `group relative flex w-full items-stretch rounded-md bg-destructive/10${session.archived ? " opacity-60" : ""}`,
          "aria-busy": busy ? "true" : "false",
        },
        h(
          "div",
          {
            class: "flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-1.5",
            role: "group",
            "aria-label": "Confirm delete session",
          },
          h(
            "div",
            { class: "flex w-full items-center gap-2" },
            providerIcon(session.cli, 14, "shrink-0 text-muted-foreground"),
            h(
              "span",
              { class: "min-w-0 flex-1 truncate text-[12px] text-foreground" },
              session.title,
            ),
            busy ? icon("refresh", 12, "text-muted-foreground animate-spin") : null,
          ),
          h(
            "span",
            { class: "w-full truncate pl-5 text-[10px] text-destructive" },
            "Delete permanently? This cannot be undone.",
          ),
        ),
        h(
          "div",
          { class: "flex items-center gap-0.5 pr-1.5" },
          h(
            "button",
            {
              type: "button",
              title: "Confirm delete",
              "aria-label": "Confirm delete",
              "data-delete-confirm": dataKey,
              disabled: busy,
              class:
                "flex min-h-6 min-w-6 items-center justify-center rounded p-0.5 text-destructive outline-none hover:bg-accent disabled:opacity-40",
              onmousedown: (e) => e.preventDefault(),
              onkeydown: (e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  this.cancelDelete();
                }
              },
              onclick: (e) => {
                e.stopPropagation();
                this.confirmDelete();
              },
            },
            icon("check", 12),
          ),
          h(
            "button",
            {
              type: "button",
              title: "Cancel delete",
              "aria-label": "Cancel delete",
              disabled: busy,
              class:
                "flex min-h-6 min-w-6 items-center justify-center rounded p-0.5 text-muted-foreground outline-none hover:text-foreground hover:bg-accent disabled:opacity-40",
              onmousedown: (e) => e.preventDefault(),
              onkeydown: (e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  this.cancelDelete();
                }
              },
              onclick: (e) => {
                e.stopPropagation();
                this.cancelDelete();
              },
            },
            icon("x", 12),
          ),
        ),
      );
    }

    if (isEditing) {
      const inputAttrs = {
        type: "text",
        value: this.editDraft,
        "data-edit-key": dataKey,
        "aria-label": "Session title",
        autocomplete: "off",
        disabled: busy,
        class:
          "h-6 w-full min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[12px] text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60",
        oninput: (e) => {
          this.editDraft = e.target.value;
        },
        onkeydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.confirmRename();
          } else if (e.key === "Escape") {
            e.preventDefault();
            this.cancelRename();
          }
        },
      };

      return h(
        "div",
        {
          class: `group relative flex w-full items-stretch rounded-md bg-accent/40${session.archived ? " opacity-60" : ""}`,
          "aria-busy": busy ? "true" : "false",
        },
        h(
          "div",
          {
            class: "flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-1.5",
            role: "group",
            "aria-label": "Rename session",
          },
          h(
            "div",
            { class: "flex w-full items-center gap-2" },
            providerIcon(session.cli, 14, "shrink-0 text-muted-foreground"),
            session.archived
              ? icon("archive", 10, "shrink-0 text-muted-foreground")
              : null,
            h("input", inputAttrs),
            busy ? icon("refresh", 12, "text-muted-foreground animate-spin") : null,
          ),
          secondary
            ? h(
                "span",
                { class: "w-full truncate pl-5 font-mono text-[10px] text-muted-foreground" },
                secondary,
              )
            : null,
        ),
        h(
          "div",
          { class: "flex items-center gap-0.5 pr-1.5" },
          h(
            "button",
            {
              type: "button",
              title: "Confirm rename",
              "aria-label": "Confirm rename",
              disabled: busy,
              class:
                "flex min-h-6 min-w-6 items-center justify-center rounded p-0.5 text-primary outline-none hover:bg-accent disabled:opacity-40",
              onmousedown: (e) => e.preventDefault(),
              onclick: (e) => {
                e.stopPropagation();
                this.confirmRename();
              },
            },
            icon("check", 12),
          ),
          h(
            "button",
            {
              type: "button",
              title: "Cancel rename",
              "aria-label": "Cancel rename",
              disabled: busy,
              class:
                "flex min-h-6 min-w-6 items-center justify-center rounded p-0.5 text-muted-foreground outline-none hover:text-foreground hover:bg-accent disabled:opacity-40",
              onmousedown: (e) => e.preventDefault(),
              onclick: (e) => {
                e.stopPropagation();
                this.cancelRename();
              },
            },
            icon("x", 12),
          ),
        ),
      );
    }

    const actionButtons = [];
    if (caps.rename) {
      actionButtons.push(
        h(
          "button",
          {
            type: "button",
            title: "Rename",
            "aria-label": "Rename",
            disabled: busy,
            class:
              "flex items-center rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground hover:bg-accent outline-none disabled:opacity-40",
            onclick: (e) => {
              e.stopPropagation();
              this.beginRename(session);
            },
          },
          icon("pencil", 11),
        ),
      );
    }
    if (caps.archive) {
      actionButtons.push(
        h(
          "button",
          {
            type: "button",
            title: session.archived ? "Unarchive" : "Archive",
            "aria-label": session.archived ? "Unarchive" : "Archive",
            disabled: busy,
            class:
              "flex items-center rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground hover:bg-accent outline-none disabled:opacity-40",
            onclick: (e) => {
              e.stopPropagation();
              this.archive(session);
            },
          },
          icon(session.archived ? "archive-restore" : "archive", 11),
        ),
      );
    }
    if (caps.delete) {
      actionButtons.push(
        h(
          "button",
          {
            type: "button",
            title: "Delete",
            "aria-label": "Delete",
            disabled: busy,
            class:
              "flex items-center rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-destructive hover:bg-accent outline-none disabled:opacity-40",
            onclick: (e) => {
              e.stopPropagation();
              this.beginDelete(session);
            },
          },
          icon("trash", 11),
        ),
      );
    }

    return h(
      "div",
      {
        class: `group relative flex w-full items-stretch rounded-md hover:bg-accent${session.archived ? " opacity-60" : ""}`,
      },
      h(
        "button",
        {
          type: "button",
          disabled: busy,
          "data-session-key": dataKey,
          class:
            "flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-1.5 text-left outline-none disabled:opacity-60",
          onclick: () => this.resume(session),
        },
        h(
          "div",
          { class: "flex w-full items-center gap-2" },
          providerIcon(session.cli, 14, "shrink-0 text-muted-foreground"),
          session.archived
            ? icon("archive", 10, "shrink-0 text-muted-foreground")
            : null,
          h(
            "span",
            { class: "min-w-0 flex-1 truncate text-[12px] text-foreground" },
            session.title,
          ),
          busy ? icon("refresh", 12, "text-muted-foreground animate-spin") : null,
        ),
        secondary
          ? h(
              "span",
              { class: "w-full truncate pl-5 font-mono text-[10px] text-muted-foreground" },
              secondary,
            )
          : null,
      ),
      actionButtons.length
        ? h(
            "div",
            { class: "flex items-center gap-0.5 pr-1.5" },
            ...actionButtons,
          )
        : null,
    );
  }

  footer() {
    const canStart = this.installed.length > 0;
    const startCli = pickStartCli(this.preferredCli, this.installed);
    const label = startCli
      ? `Start new ${this.installed.find((p) => p.id === startCli)?.displayName ?? startCli}`
      : "Start new session";

    return h(
      "div",
      { class: "border-t border-border px-2.5 py-2" },
      h(
        "button",
        {
          type: "button",
          disabled: !canStart,
          class:
            "flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-surface text-[12px] text-foreground outline-none hover:bg-accent disabled:opacity-50",
          onclick: () => this.startNew(),
        },
        icon("sparkles", 12),
        label,
      ),
    );
  }

  emptyState(message, showStart = false) {
    return h(
      "div",
      {
        class:
          "flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-[12px] text-muted-foreground",
      },
      h("p", null, message),
      showStart && this.installed.length
        ? h(
            "button",
            {
              type: "button",
              class:
                "h-7 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground",
              onclick: () => this.startNew(),
            },
            "Start new session",
          )
        : null,
    );
  }

  noCliState() {
    return h(
      "div",
      {
        class:
          "flex flex-col gap-2 px-4 py-8 text-[12px] text-muted-foreground",
      },
      h(
        "p",
        { class: "text-center font-medium text-foreground" },
        "No AI CLIs found on PATH",
      ),
      h(
        "p",
        { class: "text-center" },
        "Install grok, claude, codex, copilot, or cursor-agent, then refresh.",
      ),
    );
  }
}
