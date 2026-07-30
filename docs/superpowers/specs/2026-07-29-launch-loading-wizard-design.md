# Bezi Mobile Launch Loading and Selection Wizard

## Summary

The Bezi mobile screen currently renders its normal empty states while the
workspace catalog, project threads, and selected thread history are still
loading. On a fresh launch this makes a healthy connection look empty or
broken.

Replace that startup experience with a full-screen, staged launch flow that
waits for the required data, asks the user to explicitly choose a workspace and
project, opens the selected project's newest thread, and only then reveals the
existing Bezi interface.

## Goals

- Make every fresh app launch feel intentional while Bezi data is loading.
- Require an explicit workspace choice and project choice on every fresh
  launch, even when a step contains only one option.
- Automatically open the chosen project's newest thread.
- Never flash the normal Bezi empty states before initial data requests finish.
- Keep the established in-app workspace and project switching behavior after
  launch.
- Give initial request failures a clear retry path.

## Non-goals

- Changing pairing, authentication, or host selection.
- Redesigning the main thread, drawer, workspace, or project picker surfaces.
- Persisting wizard progress between process launches.
- Changing the server ordering or definition of the newest thread.
- Creating a thread automatically when the chosen project has none.

## User Flow

1. On every fresh app launch, the Bezi tab presents a full-screen branded
   loading state instead of the normal app shell.
2. While the relay session is not ready, the status reads "Connecting to Bezi."
3. Once connected, the flow requests the workspace catalog and displays
   "Loading workspaces."
4. After the catalog resolves, the flow displays "Choose a workspace" with
   large, full-width workspace buttons.
5. The user must tap a workspace. The flow then displays "Choose a project"
   using the same large-button pattern. A Back action returns to the workspace
   step.
6. The user must tap a project. The flow applies both selections and requests
   that project's threads.
7. While the thread list loads, the status reads "Loading your latest thread."
8. If threads exist, the flow selects the first entry in the existing
   newest-first server ordering, requests its history, and reads "Opening
   newest thread."
9. After history resolves, the normal Bezi interface is revealed with that
   thread active.
10. If no threads exist, the normal interface is revealed in its existing
    "Start a thread" state.

After the launch flow reaches ready, normal background catalog and thread
polling continues without reopening the wizard. A later disconnect uses the
existing offline UI.

## Visual Design

The launch flow extends the existing mobile design system:

- Background: the current dark Bezi background.
- Typography: the existing title, body, label, and caption styles.
- Accent and status colors: current primary, muted text, border, danger, and
  surface tokens.
- Icons: existing Material Community grid, folder, chevron, connection, and
  alert icons.

The layout is vertically spacious and safe-area aware:

- A compact Bezi mark or app identity near the top.
- A two-step Workspace / Project progress indicator on choice screens.
- A prominent title and one concise guidance sentence.
- Large full-width choice buttons with at least a 64-point tap target.
- Workspace choices show a grid icon, workspace name, project count, active
  desktop status when applicable, and a chevron.
- Project choices show a folder icon, project name, shortened path, and a
  chevron.
- Loading screens center an activity indicator, status title, and brief
  supporting text.
- Error screens use an alert icon, request-specific message, and a large Retry
  action.

Transitions between choice steps use short opacity and positional motion with
light haptic selection feedback. Reduced-motion users receive an immediate
state change without positional animation.

## State Architecture

Create a focused launch-flow state model with these phases:

- `connecting`
- `loading-workspaces`
- `choose-workspace`
- `choose-project`
- `loading-threads`
- `loading-thread`
- `ready`
- `error`

The model owns:

- the current phase;
- the explicitly chosen workspace ID;
- the explicitly chosen project ID;
- the request operation that failed, when applicable; and
- enough retry information to repeat only the failed initial operation.

Launch choices remain separate from automatic desktop-active selection and
background polling. Existing selection effects may keep app data synchronized,
but they cannot satisfy or advance a wizard step. Only an explicit button tap
advances `choose-workspace` or `choose-project`.

The launch screen remains mounted until the selected project's initial thread
list has resolved and, when a newest thread exists, that thread's history has
also resolved. This prevents early empty-state flashes.

## Data Flow

### Workspace catalog

When connected, send the existing `bezi.catalog.get` request. A matching
`bezi.catalog` response populates the catalog and advances the launch flow to
workspace choice. Periodic catalog refresh continues after launch but cannot
change launch phases.

### Project selection and threads

After an explicit project tap, apply the chosen workspace and project IDs and
send the existing `bezi.session.list` request with the project's `cwd`. A
matching response continues using the existing session parser and newest-first
ordering.

If the list is empty, clear the active session and advance to `ready`. If the
list has entries, select the first entry and send the existing history load
request.

### Thread history

The launch flow advances to `ready` only after the matching initial history
response has been reconciled into messages. Later periodic history
synchronization does not affect launch state.

## Errors, Timeouts, and Reconnection

- A catalog error produces an initial-load error naming workspaces as the
  failed resource.
- A session-list error names project threads as the failed resource.
- A history error names the newest thread as the failed resource.
- Retry repeats the failed operation without discarding valid earlier choices.
- If the relay disconnects during initial loading, the flow returns to a
  connecting presentation while retaining valid explicit choices in memory.
  When the relay reconnects, it resumes the required request.
- An unusually long request keeps the user on the branded waiting surface and
  changes the supporting copy to indicate that Bezi is still responding. It
  does not reveal the unfinished app.

## Accessibility

- All choice rows and retry/back actions expose button roles and descriptive
  accessibility labels.
- Choice rows use a minimum 64-point tap target.
- Loading status changes use a polite live region.
- Error messages are announced when they appear.
- Color is not the only indicator of progress or error.
- Motion respects the platform reduced-motion preference.
- Long names and paths truncate without obscuring the primary choice label.

## Testing and Verification

### Automated

- Unit-test launch state transitions.
- Verify that one workspace still requires an explicit tap.
- Verify that one project still requires an explicit tap.
- Verify catalog success and catalog retry.
- Verify project back navigation.
- Verify an empty project advances to the existing start-thread state.
- Verify multiple threads choose the newest existing entry.
- Verify history success and history retry.
- Verify disconnect/reconnect during each loading phase.
- Run the existing Bezi session/history tests.
- Run mobile TypeScript checking and linting.

### Visual and interaction

At a representative phone viewport:

- Confirm no normal app chrome or empty state flashes before launch readiness.
- Confirm loading, workspace, project, thread-loading, empty-project, and error
  states use the existing design system.
- Confirm large buttons, safe-area spacing, truncation, Back, Retry, and haptic
  transitions.
- Complete the workspace to project to newest-thread path and confirm the
  correct thread and history are visible.
- Confirm later polling and disconnect behavior do not reopen the wizard.

## Acceptance Criteria

- Every fresh launch displays the staged launch flow.
- The app waits for real catalog data before showing workspace choices.
- The user explicitly confirms both workspace and project on every launch.
- Selecting a project opens its newest thread after its history finishes
  loading.
- Projects without threads land on the existing start-thread state.
- Initial failures stay on a clear branded error/retry surface.
- The normal Bezi interface never appears half-populated during initial load.
- Existing post-launch switching, polling, offline, and thread behavior remains
  functional.
