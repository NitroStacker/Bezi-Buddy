# Bezi Remote Unity Integration

This package is Editor-only. It registers the open Unity project with the local
Bezi Remote companion and exposes explicit semantic commands for hierarchy,
selection, serialized-property inspection, staged property writes, and Play
Mode controls.

## Install for development

Add the package from disk through Unity Package Manager, or run the guarded
installer from the repository root:

```powershell
.\scripts\Install-UnityPackage.ps1 -UnityProject 'R:\My Unity Project'
```

The installer previews its target, refuses a collision, and backs up the
project manifest before adding an embedded package. It does not edit scenes,
assets, or player builds.

## Collaboration contract

- Purpose: provide Editor metadata and safe semantic mutations to the local
  Windows companion.
- Placement: package installation only; no scene object or bootstrap is needed.
- Dependencies: Unity 6 Editor and the companion named pipe
  `\\.\pipe\bezi-remote-unity-v1`.
- Lifecycle: starts after Editor domain load, reconnects in the background, and
  disconnects before assembly reload or Editor quit.
- Player impact: none. All source is in an Editor-only assembly definition.
- Save behavior: ScriptableObject assets are explicitly saved after Apply.
  Scene-object changes mark the scene dirty but never save it.
- Unsupported properties: managed references and unrecognized types are
  returned read-only.

