# Engineering case study — TH108 Lighting Suite

There is no public per-key lighting API for this keyboard. Everything here started as a
black box: raw USB packets, an undocumented protocol, and hardware that fights back —
muting itself, resetting its own effects, and dropping keystrokes under load.

This page documents the engineering that came out of that: seven real faults, each traced
to a root cause and fixed rather than patched over.

| | |
|---|---|
| **Commits** | 927 |
| **Build window** | 7 Jun – 31 Aug 2026 (3 months, solo) |
| **Tests** | 249 passing, 0 failing — 816 assertions across 21 files |
| **Source** | 12,601 lines of JS across 33 files |
| **Frameworks** | none — vanilla JS, no build step, no browser production dependencies |

Run the suite yourself with `node --test` in `app/` and `th108-daemon/`.

---

## 1. The keyboard that mutes itself

**Symptom.** The lighting pipe wedges and stops accepting frames — sometimes seconds after a
keystroke, sometimes on wake, sometimes only while a game or capture app is running.

**Root cause.** Not one bug but a family of them: USB bandwidth contention, the OS
re-enumerating the device mid-keystroke, and other software (Steam Input, for one) probing
the shared HID channel and desyncing it.

**Fix.** A staged recovery ladder — retry, then a forced USB re-enumeration, then heavier
resets — gated on a keypress lull so it never fires mid-typing, with held keys tracked so
none stick.

## 2. The false acknowledgement

**Symptom.** Writes to the board would intermittently freeze the whole lighting stream.

**Root cause.** Each write waits for the board to confirm before the next is sent. The board
*also* emits unsolicited status messages, and those were falsely satisfying that
confirmation, so the sender advanced out of sync.

**Fix.** Distinguish a real acknowledgement from a coincidental one by matching the *echoed
byte offset* of the write — a one-line discriminator, findable only by reading the raw
packet stream.

## 3. Reverse-engineering the lighting protocol

**Goal.** Paint any color on any individual key from a web page.

**Dead end.** The obvious HTTP endpoint the board exposes turned out to be read-only for
colors — a decoy.

**Result.** The real path is a full-frame WebHID paint command bound to the correct hardware
interface. That single discovery is what makes the entire suite possible.

## 4. Two programs, one keyboard

**Symptom.** When both the web page and the always-on daemon tried to drive the board, they
collided and the lighting froze.

**Root cause.** The hardware tolerates exactly one writer at a time.

**Fix.** A shared lighting engine used by both, plus an explicit hand-off protocol — whoever
is driving cleanly yields control to the other. That is why lighting survives closing the tab.

## 5. The rainbow that wouldn't die

**Symptom.** A firmware rainbow flashed across the board during any restart or recovery gap.

**Root cause.** The board's built-in effect silently re-arms itself every time the device
re-enumerates over USB.

**Fix.** Re-assert a black mask on every fresh connection, tied to the re-enumeration event,
so the stock effect never gets a window to show.

## 6. Stuck keys after wake and under load

**Symptom.** In some games keys would stick — both lit, and worse, stuck *down* as input —
after sleep/wake or heavy activity.

**Root cause.** The global key hook dropped release events when the device re-enumerated
mid-keystroke, and animation clocks jumped after wake from an unclamped time delta.

**Fix.** Track held keys and release them on focus loss, clamp the frame delta so clocks
can't leap on wake, and gate risky recovery on a typing lull.

A lighting tool must never break the keyboard it lights.

## 7. Disproving the obvious culprit

**Symptom.** An audio device muted on every sleep/wake, and the keyboard was the prime
suspect — it shares a USB controller.

**Root cause.** The keyboard, the daemon, and the shared-USB theory were each disproved in
turn. The real fault was a Windows audio-stack resume regression, unrelated to this project.

**Fix.** A small wake-time service restart — and, more usefully, the evidence that stopped
the wrong component from being blamed.

## 8. Auditing my own project, and finding real problems

**Symptom.** The suite was publicly accused of being a keylogger. Three of the four specific
claims did not survive contact with the code — but "we checked and we're fine" is exactly what
a compromised project would say, so the project was put through two independent adversarial
security audits with an explicit instruction to assume the previous review had blind spots.

**Root cause.** The audits agreed, and they found things the accusation had missed entirely.
The worst was not the keyboard hook at all: a recovery task ran with administrator rights, but
its payload sat in the project folder, which any program running as the logged-in user can
overwrite. That turns a convenience feature into a way for ordinary software to gain
administrator access without a prompt. Second was a debug log that recorded window titles —
and a code-editor window puts the filename you have open, and the sentence you are mid-way
through typing, in its title. So a project promising it stored nothing you typed was, in one
narrow path, storing fragments of it. Third, the page loaded its two fonts from Google, which
contacted a third party on every single page load while the documentation claimed there was no
remote endpoint.

**Fix.** The elevated task's payload moved to an administrator-only directory — a pattern this
project already used elsewhere and had failed to apply consistently. Window titles were removed
from every log, the log was capped, and the leftover debug probe behind it was deleted. The
fonts were self-hosted, making the "no remote endpoint" claim literally true. The localhost
server's cross-origin guard was extended from POST-only to every method (a plain image tag on
any web page could previously pop a native file dialog), and it now serves only the web app
rather than the whole project folder. The browser device pre-grant was narrowed from an entire
vendor to this one keyboard. Dependencies were pinned to exact versions. And the documentation
was corrected where it had been generous with itself.

The interesting part is not that a hobby project had security bugs. It is that the loudest
public accusation was wrong, and the quiet audit that followed it was right — about entirely
different things.

---

## What this demonstrates

- **Reverse engineering** — recovered an undocumented USB HID protocol from raw traffic, with no SDK or reference.
- **Low-level debugging** — traced faults across the hardware, USB, OS and browser boundaries to real root causes.
- **Concurrency** — a single-writer hardware resource shared safely between a web page and a background service.
- **Test discipline** — 249 unit tests on the standard Node runner, no framework required.
- **Privacy-first design** — local-only; the hook reads key positions, not typed characters, and the daemon makes no outbound requests at all. The page loads no third-party resources. The localhost server is hardened against DNS-rebinding and cross-origin requests on every method. See [Privacy & the keyboard hook](README.md#privacy--the-keyboard-hook).
- **Taking criticism seriously** — commissioned adversarial security audits after a public accusation, then fixed what they found, including a privilege-escalation hole the accusation never spotted (section 8).
- **Sustained solo delivery** — 927 commits over three months, in public, including a month of pure polish and hardware testing.

## Stack

WebHID for direct device access · vanilla JS for a zero-framework UI · Canvas and WebGL for
the lighting compositor · Node for the always-on daemon · `node-hid` for native HID
transport · a localhost server hardened against DNS-rebinding · `node --test` for the suite.
