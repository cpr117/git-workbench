# Changelog

## 0.15.0 — Marketplace preparation

- Rename the extension to Orbit Git with Marketplace publisher ID `PRCooper` and extension ID `PRCooper.orbit-git`; keep the GitHub repository owner unchanged.
- Add an original PNG extension icon. Menus, command categories and status-bar entries use the same name; `gitWorkbench.*` settings remain compatible.
- Open history in editor tabs automatically on Windows, Linux and remote workspaces; local macOS continues to prefer native popups.
- Fall back to a tab when the initial popup cannot start. Failed manual popup switches keep the existing tab and selected revisions.
- Hide the popup switch on unsupported hosts and compile before packaging.
- Expand comparison trees after the host finishes positioning the view; closing its Diff tab hides the comparison section.
- Remove organization-specific guide links and pin compatible packaging dependencies to resolve security advisories.
- Add a manual GitHub Actions workflow for verified packages and optional Marketplace publishing with OIDC.

Users switching from `local-tools.git-workbench` or the local `cpr117.orbit-git` preview should uninstall the old extension before installing this one.

## 0.14.5

- Add ten module switches in one compact settings list, with immediate updates and migration of older preferences.
- Unify Explorer Git menus for files, folders and projects.
- Fix history navigation with filtered revision lists.

## 0.14.0

- Add a Stash browser with a changed-file tree and native Diff.
- Refresh Stash automatically after external changes.
- Reuse native Source Control for working-tree changes and commits.
