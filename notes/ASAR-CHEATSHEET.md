# app.asar cheatsheet (verified on this build)

Numbers below were measured on
`D:\deepseek\dsh_windows\file\resources\app.asar` (182,434,783 bytes,
Electron 44.7.0). Treat them as a worked example, not constants — always re-read
the header.

## Layout

```
[0..3]    uint32 LE  = 4                  (size of the next pickle field)
[4..7]    uint32 LE  = headerSize         (4748096 on this build)
[8..11]   uint32 LE  = headerSize - 4     (= JSON length + padding)
[12..15]  uint32 LE  = jsonLen            (4748087 on this build)
[16..]    JSON header, jsonLen bytes
[8 + headerSize ..]  file data area       (4748104 on this build)
```

Each entry in the JSON `files` tree carries `{ "size": N, "offset": "S" }`, and its
bytes live at `dataBase + S` for `N` bytes. `offset` is a **string**.

## Read one file (PowerShell, no dependencies)

```powershell
$a = 'C:\path\app.asar'
$fs = [IO.File]::OpenRead($a)
$h  = New-Object byte[] 16;             $fs.Read($h,0,16) | Out-Null
$headerSize = [BitConverter]::ToUInt32($h,4)
$jsonLen    = [BitConverter]::ToUInt32($h,12)
$jsonBytes  = New-Object byte[] $jsonLen; $fs.Read($jsonBytes,0,$jsonLen) | Out-Null
$base = 8 + $headerSize
$tree = [Text.Encoding]::UTF8.GetString($jsonBytes) | ConvertFrom-Json

# walk $tree.files to the node you want, then:
$fs.Position = $base + [int64]$node.offset
$buf = New-Object byte[] $node.size;  $fs.Read($buf,0,$node.size) | Out-Null
[IO.File]::WriteAllBytes('out.js', $buf)
```

Walking the tree: a directory node has `files`; a file node has `offset` + `size`.

## Two ways to change a file

**A. Same-length patch (safest, no repack).** If the replacement is byte-identical
in length, write at `dataBase + offset` and stop. Nothing else in the archive moves.
Useful for flipping a boolean or an allowlist entry *without changing its size*.

**B. Repack (needed for any real edit).** Rebuild the archive:

1. unpack every entry to a temp tree (preserving mode);
2. edit files normally;
3. walk the tree again in a **stable order**, writing data sequentially and
   recording each entry's new `offset`/`size`;
4. serialise the JSON header, pad it to a 4-byte boundary, recompute the three
   length fields at [0..15], then write header + data.

The counts at [8..11] must equal `jsonLen + padding`, and `headerSize` must equal
`jsonLen + padding + 4`; the parser is strict about that relationship.

## Gotchas found the hard way

- **Shell tools cannot read inside `app.asar`.** `Get-ChildItem`, `cat`, ripgrep and
  `node` all fail; only code that opens the archive (or the Host process itself)
  can. Extract to a temp dir first, then use normal tools.
- **`app.asar.unpacked` is a real directory** next to the archive: native binaries and
  some assets live there, not inside the archive.
- **A running app holds the archive.** Writing while DSH is running corrupts nothing
  (it is read once at start) but the change only takes effect after a full restart.
- **The updater overwrites `app.asar`.** Any patch is a fork: keep the recipe in
  version control and re-apply after each upgrade, or ship your own build.

## Verifying a patch actually took effect

Do not trust "it loaded". Use an artefact:

1. restart the app;
2. from the renderer you can read `window.__DSH_BOOT__` (boot entries) and call your
   new verb once with a payload you can recognise;
3. on the other side, **write that payload to a file** and read the file. A resolved
   promise proves only that your own code ran.
