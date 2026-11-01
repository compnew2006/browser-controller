# Driving a guest OS through a remote console

Field guide for using the Browser Controller against a hypervisor or
appliance web client whose guests are reachable only through an
in-browser console — the ESXi/vSphere host client is the case verified
here, and the same shape (canvas-based console behind a web UI) recurs in
other appliances.

**Verified on 2026-11-01** against the ESXi host client at
`https://192.168.0.114/ui/#/host/vms/13` (VM 13 "DC", Windows Server 2025,
`ARKAN-DC02`), driven from a real Chrome profile through the MCP server.
Everything marked *verified* was observed in that session. The Linux
guest path (section 8) is reasoned from the same run and is **not** yet
verified end to end.

## 1. Why a console is not the normal web case

A guest console is a canvas, not a document. Three consequences shape
everything else:

- there is no DOM to read, so guest state is read from pixels;
- there is no focusable field to type into, so `browser_type` with
  `text` cannot work;
- the host UI and the guest UI are two different pages, and they fail
  differently (section 3).

The host client itself is an ordinary SPA and is driven with ordinary
tools: `browser_navigate` to the hash route, then `browser_snapshot` for
refs and roles.

    https://<host>/ui/#/host/vms/<vmid>

## 2. Opening a guest console: use "new tab", not "new window"

*Verified.* The **Console** action in the ESXi host client is a menu, not
a button. The sequence is:

1. click the link `Open a console to this virtual machine` (role `link`);
2. a menu appears with `Open console in new window`, `Open console in new
   tab`, `Reset to native resolution` and `Console` options;
3. click `Open console in new tab`.

**"New window" is the trap.** It calls `window.open()`. A CDP-dispatched
click carries no user activation, so Chrome treats it as an unactivated
popup and blocks it — the call succeeds and no window appears, which reads
like a broken button. *Verified:* after the host was added to Chrome's
pop-up allowlist (`chrome://settings/content/popups`), the same click
opened a real console window. Keep the allowlist entry for manual use, but
drive the **new tab** path, which has no such dependency.

The console URL has the shape `https://<host>/ui/#/console/<vmid>` and the
tab title becomes `<VMNAME> - Console - VMware ESXi`.

The menu closes on any outside click, so re-open it before choosing an
item. `browser_tabs {browser}` re-binds the session to one Chrome profile;
doing that mid-task makes every tab from the previous profile report
`TAB_NOT_FOUND` (section 9).

## 3. The credential shield is per-tab, not per-site

*Verified.* On the ESXi **host client** tab — the one carrying the `root`
login form — `browser_evaluate` and `browser_screenshot` both fail:

    VAULT_CONTEXT_PROTECTED: This operation is blocked because the page
    may contain a saved password.

Chrome's password manager holds a credential for that form, so the
controller refuses to read or photograph the document. The **console tab
is a different document with no credential field**, and both tools work
there without exception.

The operational rule: read guest state through the console tab, never
through the host-client tab. When a console task starts with
`VAULT_CONTEXT_PROTECTED` on evaluate or screenshot, the fix is to change
tabs, not to unlock anything.

## 4. The canvas and its coordinate space

*Verified.* The console surface is `document.querySelector("#mainCanvas")`
(noVNC). Two numbers describe it and they are not equal:

| | observed |
|---|---|
| canvas backing store | 1920 × 918 (guest resolution) |
| CSS rect of the same canvas | 1888 × 903 (scaled into the window) |

Chrome scales the backing store to the window, so **drive pointer
coordinates from `getBoundingClientRect()`, never from `canvas.width`
and `canvas.height`** — the latter is ~1.6 % off in that session, which is
enough to miss a small target.

To convert a screenshot back into page coordinates:

    css_x = shot_x * rect.width / shot_width
    css_y = shot_y * rect.height / shot_height

`browser_click {target:"x,y"}` takes viewport CSS pixels, so the formula
above feeds it directly. The canvas sits at the top-left of the viewport,
so viewport coordinates and canvas coordinates agree.

## 5. Keyboard: what actually reaches the guest

*Verified.* The guest UI is pixels, so there is nothing in the page for
`browser_type {text}` to focus:

    NO_FOCUS: no field has focus: pass target, or click the field first.

Use `browser_type {key}` instead. It sends one key, a combo, or several
keys in order — `"c m d"` types three characters.

| Reaches the guest | Does not reach the guest |
|---|---|
| `a`–`z`, `0`–`9`, Space, Enter | `/` `:` `;` `-` `.` |
| combos: `Alt+F4`, `Control+Escape` | any punctuation, including `key:"Slash"` and `key:"Shift+Semicolon"` |

Punctuation is dropped silently — the command still runs, with the
punctuation missing. *Verified:* `nltest` + `/dclist:ARKAN` arrived as
`dclist;arkan`, and a typed `:` can land as `;` when the shift is not
applied.

Consequences for guest work:

- prefer letter-only commands: `systeminfo`, `hostname`, `whoami`,
  `net start`, `sc query <ServiceName>`;
- for anything that needs `/` or `-` (`nltest /dclist:ARKAN`,
  `Get-ADDomainController`), use the guest GUI instead — Server Manager —
  or click the punctuation key by coordinate;
- `Control+Escape` opens the guest Start menu reliably. The **Windows
  key** is a browser- and OS-level accelerator and is eaten by Chrome
  before it reaches the guest; do not use it.

## 6. A verified guest session

*Verified* on the Windows Server 2025 guest (DC), typed through the
console with the key-sequence method:

    whoami      -> arkan\administrator
    hostname    -> ARKAN-DC02
    systeminfo  -> Domain: arkan.local ; Logon Server: \\ARKAN-DC02
                   Ethernet0 192.168.0.97 ; Time Zone (UTC+03:00) Kuwait, Riyadh
                   OS 10.0.26100.33296 ; 8 GB RAM ; Xeon E5-2699A v4
    net view    -> System error 6188 (server list unavailable)

The host client's role tiles (AD DS, DNS, File and Storage Services,
Print Services, with a stopped-service badge on *Local Server*), the
*Local Server* properties page and its event log are all reachable by
canvas coordinates.

## 7. Administering the host and creating VMs

The host client exposes the whole hypervisor through the same tree:

| Route | What it covers |
|---|---|
| `#/host/vms` | inventory, power state, snapshots, templates, create/register VM |
| `#/host/manage` | host settings, storage, networking |
| `#/host/monitor` | logs, performance, hardware state |

**Creating a VM and installing a guest OS.** The host client's own path:
open the *Virtual Machines* view, choose **Create / Register VM**, then
*Create new virtual machine*; pick the target host or cluster, the guest
OS family and version, the resource profile (CPU cores, memory, disk
size and format), and the datastore; attach an ISO from the datastore;
finish the wizard, then power the VM on and drive the installer through
the console exactly as in sections 4–6 — the guest OS install is an
ordinary guest session, reachable by the same canvas and keyboard path.

Read the real field names and current values from the accessibility tree
(`browser_snapshot`) instead of assuming labels; the host client
relabels fields between versions. Confirm with the operator before
destructive actions: power off, delete, disk resize, snapshot removal,
NIC reconfiguration.

*Not yet verified end to end:* the create-VM wizard and a guest OS
install were not run in the session this document is based on. The
procedure above is the host client's documented path, and the console
mechanics it depends on are verified; treat the wizard itself as a
procedure to validate on first use.

## 8. Linux guests

*Reasoned, not verified.* Everything in sections 1–5 is a property of the
console surface rather than of the guest OS: the canvas and its scale
factor, the per-tab credential shield, the dropped punctuation, and the
key-sequence method are all host-side behaviour and carry over unchanged.

What changes on a Linux guest is the shell and the shortcuts: `Ctrl`
plus a function key switches virtual terminals (`Ctrl+Alt+F2` to
`Ctrl+Alt+F6`) where a graphical console would show a login prompt, and
`Ctrl+Alt+T` opens a terminal on most desktop distributions. `Ctrl+Escape`
has no Windows Start menu equivalent, so open a terminal through the
distribution's own menu instead.

## 9. Housekeeping

*Verified.*

- **One console session per guest.** Two live noVNC tabs on the same VM
  fight over the keyboard. Close the older tab before opening a second.
- **Do not pass `browser` to `browser_tabs` mid-task.** It re-binds the
  session to that Chrome profile, and every tab from the previous profile
  then fails with `TAB_NOT_FOUND`. Re-list instead.
- **Guest windows scroll themselves.** A page-level `browser_scroll` does
  not move a guest window's contents; scroll with the wheel over the
  canvas (`browser_scroll {target:"#mainCanvas", dy:…}`).
- The host-client tab answers `browser_tabs` and `browser_snapshot`
  reliably, but not `browser_evaluate` (section 3).

## 10. Summary of the working recipe

1. `browser_navigate` to `https://<host>/ui/#/host/vms/<vmid>`;
2. `browser_snapshot` to get the refs, click the *Console* link, then the
   `Open console in new tab` menu item;
3. work in the console tab — evaluate and screenshot work there;
4. read the canvas rect, convert coordinates, click with `x,y`;
5. send keystrokes with `key` sequences, never with `text`;
6. close the previous console tab before opening another one.
