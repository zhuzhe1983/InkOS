import type { InkFrameSidecar, InkHitbox, InkPackageManifest } from "./contracts";

export interface InkVisit {
  documentUuid: string;
  pageIndex: number;
}

export interface InkNavigationState extends InkVisit {
  history: InkVisit[];
}

export type InkNavigationCommand =
  | { type: "swipe-left" }
  | { type: "swipe-up" }
  | { type: "swipe-down" }
  | { type: "tap"; x: number; y: number };

export type InkNavigationReason =
  | "parent"
  | "next-page"
  | "previous-page"
  | "linked-document"
  | "root"
  | "end"
  | "no-hit";

export interface InkNavigationResult {
  state: InkNavigationState;
  changed: boolean;
  reason: InkNavigationReason;
  interaction?: InkHitbox;
}

export function initialNavigationState(manifest: InkPackageManifest): InkNavigationState {
  return { documentUuid: manifest.entryUuid, pageIndex: 0, history: [] };
}

function hitboxArea(hitbox: InkHitbox): number {
  return hitbox.bounds.width * hitbox.bounds.height;
}

export function hitTest(interactions: InkHitbox[], x: number, y: number): InkHitbox | undefined {
  return interactions
    .filter(({ bounds }) => {
      return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
    })
    .sort((left, right) => hitboxArea(left) - hitboxArea(right))[0];
}

function unchanged(state: InkNavigationState, reason: InkNavigationReason): InkNavigationResult {
  return { state, changed: false, reason };
}

function openParent(
  state: InkNavigationState,
  sidecar: InkFrameSidecar,
): InkNavigationResult {
  if (!sidecar.parentUuid) return unchanged(state, "root");

  const history = [...state.history];
  const previous = history.at(-1);
  if (previous?.documentUuid === sidecar.parentUuid) {
    history.pop();
    return {
      state: { ...previous, history },
      changed: true,
      reason: "parent",
    };
  }

  return {
    state: { documentUuid: sidecar.parentUuid, pageIndex: 0, history: [] },
    changed: true,
    reason: "parent",
  };
}

export function navigateInk(
  state: InkNavigationState,
  sidecar: InkFrameSidecar,
  command: InkNavigationCommand,
): InkNavigationResult {
  if (sidecar.documentUuid !== state.documentUuid || sidecar.pageIndex !== state.pageIndex) {
    throw new Error("Navigation sidecar does not describe the active frame");
  }

  switch (command.type) {
    case "swipe-left":
      return openParent(state, sidecar);
    case "swipe-up":
      if (state.pageIndex + 1 >= sidecar.pageCount) return unchanged(state, "end");
      return {
        state: { ...state, pageIndex: state.pageIndex + 1 },
        changed: true,
        reason: "next-page",
      };
    case "swipe-down":
      if (state.pageIndex > 0) {
        return {
          state: { ...state, pageIndex: state.pageIndex - 1 },
          changed: true,
          reason: "previous-page",
        };
      }
      return openParent(state, sidecar);
    case "tap": {
      const interaction = hitTest(sidecar.interactions, command.x, command.y);
      if (!interaction) return unchanged(state, "no-hit");
      if (interaction.targetUuid === state.documentUuid) return unchanged(state, "no-hit");
      return {
        state: {
          documentUuid: interaction.targetUuid,
          pageIndex: 0,
          history: [...state.history, { documentUuid: state.documentUuid, pageIndex: state.pageIndex }],
        },
        changed: true,
        reason: "linked-document",
        interaction,
      };
    }
  }
}
