# Codex Apple Light Video Design

## Goal

Create a horizontal promotional video for Codex that feels like an Apple-style product film: clean, white, quiet, precise, and premium. The video should show a realistic Codex bug-fix workflow on macOS, including prompt entry, project understanding, patch creation, verification, and final readiness.

## Format

- Aspect ratio: 16:9 horizontal.
- Duration: about 50 seconds.
- Primary use: product introduction, website hero media, and high-quality social reposts that support horizontal video.
- Tone: calm, exact, confident, minimal.

## Visual Identity

The entire video uses a light Apple-like palette. There should be no cyberpunk black backgrounds, dark dashboard surfaces, neon panels, or terminal-heavy dark layouts.

Palette:

- Canvas white: `#fbfbf8`
- Warm light gray: `#f7f7f4`
- Window gray: `#ececea`
- Border gray: `#d9d9d4`
- Primary text: `#1d1d1f`
- Secondary text: `#515154`
- Muted text: `#6e6e73`
- Focus blue: `#0066cc`
- Success green: `#0b6f3a`
- Success wash: `#e9f7ef`
- Completion wash: `#f0f7ff`

Typography should resemble Apple product pages: large confident headings, compact supporting copy, and restrained monospaced terminal text. The implementation should prefer system fonts and an SF Mono-like stack where available:

- Display and UI: `-apple-system`, `BlinkMacSystemFont`, `SF Pro Display`, `Inter`, `Segoe UI`, sans-serif.
- Terminal: `SFMono-Regular`, `Menlo`, `Consolas`, monospace.

## Interface Design

The central UI is a light macOS terminal-style window, not a black terminal. It should use:

- White or near-white terminal body.
- Light gray title bar.
- macOS red, yellow, and green window controls.
- Deep gray terminal text.
- Blue prompt highlight for the user request.
- Green success highlight for patch and test output.
- Subtle shadows and borders for depth.

All supporting cards and timeline panels should remain white or pale gray. The final state uses a pale blue completion card, not a black card.

## Storyboard

1. Opening, 0-6 seconds:
   A white product-film frame introduces "Codex on Mac." The macOS terminal window settles into view. The user prompt appears with real typing cadence: `codex "fix the diagnosis extraction bug"`.

2. Understanding, 6-16 seconds:
   Codex reads project context. Light file chips and plan steps appear in calm motion around the terminal. The copy should stay sparse, using phrases like "reading project context" and "preparing focused patch."

3. Patch, 16-31 seconds:
   The patch is shown as focused terminal output or a light diff panel. Additions are highlighted with deep green text on a pale green wash. The motion is precise: line reveal, gentle focus highlight, and no flashy scanlines or neon effects.

4. Verify, 31-43 seconds:
   A test command runs. Status lines resolve into passing checks. The audio should include command entry, light terminal feedback, and a subtle completion tone.

5. Finish, 43-50 seconds:
   The final frame shows a pale blue completion state with concise copy: "Ready to ship." The closing feel is quiet and premium, with the terminal and headline aligned cleanly in a white composition.

## Motion Direction

Motion should feel like Apple product animation: slow enough to read, fast enough to feel competent, and always purposeful.

- Use gentle camera push-ins, soft window settles, and clean line reveals.
- Avoid glitch, cyber scan, heavy blur, neon glow, noisy grids, and aggressive shake.
- Highlight text with small color and background changes rather than flashy effects.
- Maintain generous whitespace around every major element.
- Every scene should transition smoothly, with no jump cuts.

## Audio Direction

The video needs realistic Codex usage sound and premium background music.

Sound layers:

- Soft Mac-style typing sounds for prompt entry and patch output.
- Light command-enter and terminal feedback sounds.
- A subtle completion chime when tests pass.
- Minimal premium background music with restrained low end, soft pulses, and no aggressive trailer hits.

The audio mix should keep UI sounds audible without making the background music feel busy.

## Tool Responsibilities

Canva:

- Create or guide a visual flow board and cover-style storyboard reference in the confirmed Apple light style.
- Keep Canva output as design reference, not the source of final rendered animation.

HyperFrames:

- Build the animated HTML UI composition.
- Implement the macOS light terminal, timeline panels, line reveals, prompt typing, patch highlight, verification state, and scene transitions.
- Validate layout and contrast before render.

Remotion:

- Compose the final video timeline.
- Add sound effects, background music, audio timing, and final export.
- Use frame-based animation logic only if Remotion-native scenes or overlays are needed.

## Acceptance Criteria

- The rendered video is 16:9 and about 50 seconds.
- The entire visual system is white, warm gray, and light UI surfaces.
- There are no black or cyberpunk scene backgrounds.
- The terminal is a light macOS-style terminal.
- Text remains readable on white and gray surfaces.
- Blue and green highlights are dark enough to contrast with light backgrounds.
- The workflow clearly communicates prompt, understand, patch, verify, and done.
- Typing, command, test, and completion sounds are present.
- Background music supports a premium Apple-like feel without overpowering the UI.
