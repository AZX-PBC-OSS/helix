# Publishing a change

The source of this repository is `integrations/helix-actions/` in
[AZX-PBC-OSS/helix](https://github.com/AZX-PBC-OSS/helix). Every file here is a
copy of that directory; nothing is edited here directly.

To publish a change that has merged in the Helix repo:

```bash
# from a checkout of this repo, next to a checkout of helix
rsync -a --delete --exclude .git ../helix/integrations/helix-actions/ ./
git add -A
git commit -m "sync from helix <helix commit sha>"
git push
```

Then release it:

```bash
git tag -a v1.2.3 -m "v1.2.3"   # immutable release tag
git tag -f v1 v1.2.3            # move the major tag (backward-compatible changes only)
git push origin v1.2.3
git push --force origin v1
```

A breaking change gets a new major tag (`v2`) instead of moving `v1`.
