#!/usr/bin/env python3
import http.server
import socketserver
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = 8765
SESSIONS_DIR = os.path.dirname(os.path.abspath(__file__))

class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == '/api/sessions':
            self.send_sessions_list()
        elif parsed.path == '/api/content':
            session = params.get('session', [''])[0]
            file_type = params.get('type', ['review'])[0]
            version = params.get('version', ['current'])[0]
            self.send_file_content(session, file_type, version)
        elif parsed.path == '/api/terminal':
            session = params.get('session', [''])[0]
            lines = int(params.get('lines', ['100'])[0])
            self.send_terminal_output(session, lines)
        elif parsed.path == '/api/session':
            session = params.get('session', [''])[0]
            self.send_session_details(session)
        elif parsed.path == '/' or parsed.path == '/index.html':
            self.send_dashboard()
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')

        try:
            data = json.loads(body) if body else {}
        except:
            data = {}

        # Handle endpoints that don't require a session FIRST
        if parsed.path == '/api/pr-info':
            pr_url = data.get('url', '')
            self.get_pr_info(pr_url)
            return
        elif parsed.path == '/api/create-session':
            mode = data.get('mode')
            url = data.get('url')
            jira = data.get('jira')
            focus = data.get('focus')
            self.create_new_session(mode, url, jira, focus)
            return

        # All other endpoints require a valid session
        session_name = data.get('session', '')

        # Validate session name to prevent path traversal
        if not session_name or '/' in session_name or '..' in session_name:
            self.send_error(400, 'Invalid session name')
            return

        session_path = Path(SESSIONS_DIR) / session_name

        if not session_path.exists() or not session_path.is_dir():
            self.send_error(404, 'Session not found')
            return

        if parsed.path == '/api/archive':
            self.archive_session(session_path)
        elif parsed.path == '/api/delete':
            self.delete_session(session_path)
        elif parsed.path == '/api/switch-mode':
            new_mode = data.get('mode', '')
            extra_data = data.get('extra', {})
            self.switch_session_mode(session_path, new_mode, extra_data)
        elif parsed.path == '/api/focus-terminal':
            self.focus_terminal(session_path)
        elif parsed.path == '/api/start-claude':
            prompt = data.get('prompt', '')
            self.start_claude_session(session_path, prompt)
        elif parsed.path == '/api/start-acr-claude':
            self.start_acr_then_claude(session_path)
        elif parsed.path == '/api/post-pr-comment':
            file_path = data.get('file', '')
            line = data.get('line', 0)
            comment = data.get('comment', '')
            self.post_pr_comment(session_path, file_path, line, comment)
        elif parsed.path == '/api/refresh-discussion':
            self.refresh_pr_discussion(session_path)
        elif parsed.path == '/api/fix-finding':
            finding_data = data.get('finding', {})
            fix_all = data.get('fix_all', False)
            self.fix_finding(session_path, finding_data, fix_all)
        elif parsed.path == '/api/import-pr-comments':
            self.import_pr_comments(session_path)
        elif parsed.path == '/api/refresh-pr':
            mode = data.get('mode', 'claude')
            force = data.get('force', False)
            self.refresh_pr(session_path, mode, force)
        elif parsed.path == '/api/run-app':
            self.run_application(session_path)
        elif parsed.path == '/api/commit':
            message = data.get('message', '')
            self.commit_changes(session_path, message)
        elif parsed.path == '/api/rename-session':
            new_title = data.get('title', '')
            self.rename_session(session_path, new_title)
        else:
            self.send_error(404, 'Not found')

    def archive_session(self, session_path):
        import shutil
        repo_path = session_path / 'repo'
        try:
            if repo_path.exists():
                shutil.rmtree(repo_path)
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'archived'}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def rename_session(self, session_path, new_title):
        try:
            session_json = session_path / 'session.json'
            if session_json.exists():
                try:
                    with open(session_json, 'r') as f:
                        data = json.load(f)
                except (json.JSONDecodeError, ValueError):
                    data = {}
                data['display_title'] = new_title
                with open(session_json, 'w') as f:
                    json.dump(data, f, indent=2)
            else:
                # Create a minimal session.json with the title
                data = {'display_title': new_title}
                with open(session_json, 'w') as f:
                    json.dump(data, f, indent=2)
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'renamed', 'title': new_title}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def delete_session(self, session_path):
        import shutil
        try:
            shutil.rmtree(session_path)
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'deleted'}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def switch_session_mode(self, session_path, new_mode, extra_data=None):
        """Switch session mode (review/investigation/development) with optional extra context"""
        import datetime
        import subprocess
        try:
            session_json = session_path / 'session.json'
            if not session_json.exists():
                self.send_error(400, 'Session does not have v2 format')
                return

            try:
                with open(session_json) as f:
                    data = json.load(f)
            except (json.JSONDecodeError, ValueError):
                data = {}

            old_mode = data.get('mode', 'unknown')
            data['mode'] = new_mode

            # Handle mode-specific extra data
            if extra_data:
                if new_mode == 'review' and extra_data.get('pr_url'):
                    # Store PR URL for reference
                    data.setdefault('pr', {})['url'] = extra_data['pr_url']
                elif new_mode == 'development' and extra_data.get('jira'):
                    data.setdefault('jira', {})['ticket'] = extra_data['jira']
                elif new_mode == 'investigation' and extra_data.get('focus'):
                    data['focus'] = extra_data['focus']

            # Add history entry
            if 'history' not in data:
                data['history'] = []
            data['history'].append({
                'timestamp': datetime.datetime.now().isoformat(),
                'action': 'mode_switch',
                'from': old_mode,
                'to': new_mode
            })

            with open(session_json, 'w') as f:
                json.dump(data, f, indent=2)

            # Update CLAUDE.md based on new mode
            repo_path = session_path / 'repo'
            claude_md = repo_path / 'CLAUDE.md'
            if repo_path.exists() and claude_md.exists():
                # Read existing CLAUDE.md to preserve any Jira context
                existing_content = claude_md.read_text()

                # Generate new mode-specific header
                if new_mode == 'review':
                    mode_header = "# PR Review Session\\n\\nYou are reviewing this pull request."
                elif new_mode == 'development':
                    jira = data.get('jira', {}).get('ticket', '')
                    mode_header = f"# Development Session\\n\\nYou are implementing changes.\\nJira: {jira}" if jira else "# Development Session\\n\\nYou are implementing changes."
                else:
                    focus = data.get('focus', '')
                    mode_header = f"# Investigation Session\\n\\nFocus: {focus}" if focus else "# Investigation Session"

                # Preserve Jira context section if it exists
                jira_section = ""
                if "## Jira Context" in existing_content:
                    jira_match = existing_content.split("## Jira Context")
                    if len(jira_match) > 1:
                        jira_section = "\\n\\n## Jira Context" + jira_match[1].split("##")[0]

                # Write updated CLAUDE.md
                with open(claude_md, 'w') as f:
                    f.write(mode_header + jira_section)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'switched', 'from': old_mode, 'to': new_mode}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def focus_terminal(self, session_path):
        """Trigger terminal focus via AppleScript (macOS)"""
        import subprocess
        try:
            session_name = session_path.name
            found = False

            # Try iTerm2 first if installed
            if Path('/Applications/iTerm.app').exists():
                script = f'''
                tell application "iTerm"
                    activate
                    set foundTab to false
                    repeat with aWindow in windows
                        repeat with aTab in tabs of aWindow
                            repeat with aSession in sessions of aTab
                                if name of aSession contains "{session_name}" then
                                    select aTab
                                    set foundTab to true
                                    exit repeat
                                end if
                            end repeat
                            if foundTab then exit repeat
                        end repeat
                        if foundTab then exit repeat
                    end repeat
                    return foundTab
                end tell
                '''
                result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
                found = 'true' in result.stdout.lower()
            else:
                # Fall back to Terminal.app - just activate it (can't easily find specific windows)
                script = '''
                tell application "Terminal"
                    activate
                end tell
                '''
                result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
                found = result.returncode == 0

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'focused' if found else 'not_found', 'found': found}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def start_claude_session(self, session_path, prompt=''):
        """Start Claude in a new terminal with logging"""
        import subprocess
        import datetime
        try:
            session_name = session_path.name
            repo_path = session_path / 'repo'

            if not repo_path.exists():
                self.send_error(400, 'Session repo not found (may be archived)')
                return

            # Create logs directory
            logs_dir = session_path / 'logs'
            logs_dir.mkdir(exist_ok=True)
            log_file = logs_dir / f"terminal-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.log"

            # Build the command
            # Use --add-dir to allow Claude to write to session folder without permission prompts
            # direnv allow prevents ".envrc is blocked" errors when cd'ing into repos with .envrc
            if prompt:
                # With prompt: run directly (script(1) swallows prompt args)
                escaped_prompt = prompt.replace("'", "'\\''")
                claude_cmd = f"direnv allow '{repo_path}/.envrc' 2>/dev/null; cd '{repo_path}' && claude --add-dir '{session_path}' -- '{escaped_prompt}'"
            else:
                # No prompt: use script for logging
                claude_cmd = f"direnv allow '{repo_path}/.envrc' 2>/dev/null; cd '{repo_path}' && script -q '{log_file}' claude --add-dir '{session_path}'"

            # Try iTerm2 first, fall back to Terminal.app
            if Path('/Applications/iTerm.app').exists():
                script = f'''
                tell application "iTerm"
                    activate
                    if (count of windows) = 0 then
                        create window with default profile
                    end if
                    tell current window
                        create tab with default profile
                        tell current session
                            set name to "🧪 {session_name}"
                            write text "{claude_cmd}"
                        end tell
                    end tell
                end tell
                '''
            else:
                # Fall back to Terminal.app
                script = f'''
                tell application "Terminal"
                    activate
                    do script "{claude_cmd}"
                end tell
                '''
            result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)

            # Update session.json if it exists
            session_json = session_path / 'session.json'
            if session_json.exists():
                try:
                    with open(session_json) as f:
                        data = json.load(f)
                    data['terminal'] = {
                        'log_file': str(log_file),
                        'tab_name': session_name,
                        'started': datetime.datetime.now().isoformat()
                    }
                    if 'history' not in data:
                        data['history'] = []
                    data['history'].append({
                        'timestamp': datetime.datetime.now().isoformat(),
                        'action': 'terminal_started',
                        'source': 'dashboard'
                    })
                    with open(session_json, 'w') as f:
                        json.dump(data, f, indent=2)
                except (json.JSONDecodeError, ValueError):
                    pass  # session.json is empty or invalid — skip metadata update

            # Also create a simple marker file for v1 sessions
            terminal_marker = session_path / '.terminal_log'
            terminal_marker.write_text(str(log_file))

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'started',
                'log_file': str(log_file),
                'session': session_name
            }).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def start_acr_then_claude(self, session_path):
        """Run ACR quick review, then start Claude in a new terminal"""
        import subprocess
        import datetime
        try:
            session_name = session_path.name
            repo_path = session_path / 'repo'

            if not repo_path.exists():
                self.send_error(400, 'Session repo not found (may be archived)')
                return

            # Get base branch from session.json
            base_branch = 'main'
            session_json = session_path / 'session.json'
            if session_json.exists():
                try:
                    with open(session_json) as f:
                        data = json.load(f)
                    base_branch = data.get('pr', {}).get('base', 'main')
                except (json.JSONDecodeError, ValueError):
                    pass

            # Prepare ACR output file
            acr_output = session_path / 'ACR_REVIEW.md'

            # Create header
            with open(acr_output, 'w') as f:
                f.write("# ACR Review Results\n\n")
                f.write(f"- **Reviewers**: 5\n")
                f.write(f"- **Agents**: claude\n")
                f.write(f"- **Base**: {base_branch}\n")
                f.write(f"- **Date**: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write("\n---\n\n")

            # Run ACR in the repo directory
            acr_result = subprocess.run(
                ['acr', '-r', '5', '-a', 'claude', '-b', base_branch, '-t', '10m', '--local'],
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                timeout=660  # 11 minutes to allow ACR to timeout first
            )

            # Append ACR output
            with open(acr_output, 'a') as f:
                f.write(acr_result.stdout)
                if acr_result.stderr:
                    f.write("\n\n### Stderr\n```\n")
                    f.write(acr_result.stderr)
                    f.write("\n```\n")
                f.write("\n---\n\n*Generated by ACR (Agentic Code Reviewer)*\n")

            # Update session history
            if session_json.exists():
                try:
                    with open(session_json) as f:
                        data = json.load(f)
                    if 'history' not in data:
                        data['history'] = []
                    data['history'].append({
                        'timestamp': datetime.datetime.now().isoformat(),
                        'action': 'acr_review_completed',
                        'source': 'dashboard'
                    })
                    with open(session_json, 'w') as f:
                        json.dump(data, f, indent=2)
                except (json.JSONDecodeError, ValueError):
                    pass

            # Now start Claude with ACR-aware review prompt
            acr_prompt = "ACR has provided initial findings in ACR_REVIEW.md - use this as CONTEXT only. Now perform YOUR OWN comprehensive code review following the CLAUDE.md guidelines. Understand the scope, analyze every change, evaluate through all lenses (correctness, security, complexity, clarity, DRY, proper-fix-vs-hack), and write a thorough REVIEW.md with detailed findings including problem, impact, and suggested fixes."
            self.start_claude_session(session_path, acr_prompt)
            return  # start_claude_session handles the response

        except subprocess.TimeoutExpired:
            self.send_error(500, 'ACR timed out after 11 minutes')
        except FileNotFoundError:
            self.send_error(500, 'ACR not installed. Install with: brew install richhaase/tap/acr')
        except Exception as e:
            self.send_error(500, f'ACR failed: {str(e)}')

    def post_pr_comment(self, session_path, file_path, line, comment):
        """Post a review comment to the PR on GitHub"""
        import subprocess
        import re
        import tempfile
        try:
            # Debug logging
            print(f"[DEBUG] Posting comment to session: {session_path}", flush=True)
            print(f"[DEBUG] File: {file_path}, Line: {line}", flush=True)

            # Validate inputs
            if not file_path or not comment:
                self.send_error(400, 'Missing file path or comment')
                return
            # Get PR info from session
            pr_number = None
            repo_owner = None
            repo_name = None

            session_json = session_path / 'session.json'
            info_file = session_path / 'session-info.txt'

            # Try V2 format first
            if session_json.exists():
                with open(session_json) as f:
                    content = f.read().strip()
                if content:
                    data = json.loads(content)
                    pr_info = data.get('pr', {})
                    # Ensure PR number is string
                    pr_number = str(pr_info.get('number', '')).strip() or None
                    project = data.get('project', '')
                    # Parse owner/repo from project URL
                    match = re.search(r'github\.com/([^/]+)/([^/]+)', project)
                    if match:
                        repo_owner = match.group(1)
                        repo_name = match.group(2).replace('.git', '')

            # Fall back to V1 format
            if not pr_number and info_file.exists():
                content = info_file.read_text()
                # Extract PR number
                match = re.search(r'PR #(\d+)', content)
                if match:
                    pr_number = match.group(1)
                # Extract repo from URL or Repository line
                match = re.search(r'Repository:\s*([^\n]+)', content)
                if match:
                    repo_str = match.group(1).strip()
                    if '/' in repo_str:
                        parts = repo_str.split('/')
                        if len(parts) >= 2:
                            repo_owner = parts[-2]
                            repo_name = parts[-1].replace('.git', '')

            # Debug: Log extracted values
            print(f"[DEBUG] Extracted: PR#{pr_number}, Owner={repo_owner}, Repo={repo_name}", flush=True)

            if not all([pr_number, repo_owner, repo_name]):
                self.send_error(400, f'Could not determine PR info: pr={pr_number}, owner={repo_owner}, repo={repo_name}')
                return

            # Get the latest commit SHA from the PR branch
            repo_path = session_path / 'repo'
            if not repo_path.exists():
                self.send_error(400, 'Session repo not found (may be archived)')
                return

            result = subprocess.run(
                ['git', 'rev-parse', 'HEAD'],
                cwd=str(repo_path),
                capture_output=True,
                text=True
            )
            if result.returncode != 0:
                self.send_error(500, f'Failed to get commit SHA: {result.stderr}')
                return
            commit_sha = result.stdout.strip()

            # Prepare the API request body
            # GitHub requires: body, commit_id, path, line (or position for older API)
            api_body = {
                'body': comment,
                'commit_id': commit_sha,
                'path': file_path,
                'line': int(line),
                'side': 'RIGHT'  # Comment on the new version of the file
            }

            # Try posting as a review comment (on specific line)
            # This requires the line to be part of the PR diff
            # Use --input to pass comment body via stdin to avoid shell escaping issues
            api_payload = json.dumps({
                'body': comment,
                'commit_id': commit_sha,
                'path': file_path,
                'line': int(line),
                'side': 'RIGHT'
            })

            result = subprocess.run(
                [
                    'gh', 'api',
                    f'repos/{repo_owner}/{repo_name}/pulls/{pr_number}/comments',
                    '-X', 'POST',
                    '--input', '-'
                ],
                input=api_payload,
                capture_output=True,
                text=True
            )

            # If line comment fails, try as a general PR comment with file reference
            if result.returncode != 0:
                error_msg = result.stderr or result.stdout

                # Check if it's a "line not part of diff" error
                if 'pull_request_review_thread' in error_msg or 'Validation Failed' in error_msg or 'line' in error_msg.lower():
                    # Fall back to general PR comment with file:line in body
                    comment_with_location = f"**📍 {file_path}:{line}**\n\n{comment}"

                    # Write to temp file to avoid escaping issues
                    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
                        f.write(comment_with_location)
                        temp_path = f.name

                    try:
                        result = subprocess.run(
                            [
                                'gh', 'pr', 'comment', str(pr_number),
                                '--repo', f'{repo_owner}/{repo_name}',
                                '--body-file', temp_path
                            ],
                            capture_output=True,
                            text=True,
                            cwd=str(repo_path)
                        )
                    finally:
                        os.unlink(temp_path)

                    if result.returncode != 0:
                        fallback_error = result.stderr or result.stdout
                        self.send_error(500, f'GitHub API error (both line and general comment failed): {fallback_error}')
                        return

                    # General comment doesn't return JSON with URL, construct it
                    comment_url = f'https://github.com/{repo_owner}/{repo_name}/pull/{pr_number}'

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        'status': 'posted',
                        'comment_url': comment_url,
                        'pr': pr_number,
                        'file': file_path,
                        'line': line,
                        'note': 'Posted as general comment (line not in diff)'
                    }).encode())
                    return
                else:
                    self.send_error(500, f'GitHub API error: {error_msg}')
                    return

            # Parse response to get comment URL
            try:
                response_data = json.loads(result.stdout)
                comment_url = response_data.get('html_url', '')
            except:
                comment_url = ''

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'posted',
                'comment_url': comment_url,
                'pr': pr_number,
                'file': file_path,
                'line': line
            }).encode())

        except Exception as e:
            self.send_error(500, str(e))

    def _do_refresh_discussion(self, session_path, repo_owner, repo_name, pr_number):
        """Internal: fetch PR comments/reviews and write PR_DISCUSSION.md. Returns counts dict."""
        import subprocess

        output_file = session_path / 'PR_DISCUSSION.md'

        # Fetch review comments
        result = subprocess.run(
            ['gh', 'api', f'repos/{repo_owner}/{repo_name}/pulls/{pr_number}/comments', '--paginate'],
            capture_output=True, text=True
        )
        review_comments = json.loads(result.stdout) if result.returncode == 0 else []

        # Fetch PR reviews
        result = subprocess.run(
            ['gh', 'api', f'repos/{repo_owner}/{repo_name}/pulls/{pr_number}/reviews', '--paginate'],
            capture_output=True, text=True
        )
        reviews = json.loads(result.stdout) if result.returncode == 0 else []

        # Fetch issue comments
        result = subprocess.run(
            ['gh', 'api', f'repos/{repo_owner}/{repo_name}/issues/{pr_number}/comments', '--paginate'],
            capture_output=True, text=True
        )
        issue_comments = json.loads(result.stdout) if result.returncode == 0 else []

        # Write markdown file
        with open(output_file, 'w') as f:
            f.write("# PR Discussion & Review History\n\n")
            f.write("> This file contains existing comments, reviews, and discussions from the PR.\n")
            f.write("> Use this context to avoid duplicating feedback and to understand decisions already made.\n\n")

            if review_comments:
                f.write(f"## Code Review Comments ({len(review_comments)})\n\n")
                for c in review_comments:
                    line = c.get('line') or c.get('original_line') or '?'
                    f.write(f"### 📍 `{c.get('path', '?')}:{line}`\n")
                    f.write(f"**@{c.get('user', {}).get('login', '?')}** on {c.get('created_at', '')[:10]}:\n\n")
                    f.write(f"{c.get('body', '')}\n\n---\n\n")

            if reviews:
                reviews_with_body = [r for r in reviews if r.get('body')]
                if reviews_with_body:
                    f.write(f"## PR Reviews ({len(reviews_with_body)})\n\n")
                    for r in reviews_with_body:
                        state = r.get('state', '')
                        icon = '✅' if state == 'APPROVED' else '⚠️' if state == 'CHANGES_REQUESTED' else '💬'
                        f.write(f"### {icon} {state} by @{r.get('user', {}).get('login', '?')}\n")
                        f.write(f"{r.get('created_at', '')[:10]}\n\n")
                        f.write(f"{r.get('body', '')}\n\n---\n\n")

            if issue_comments:
                f.write(f"## General Discussion ({len(issue_comments)})\n\n")
                for c in issue_comments:
                    f.write(f"### 💬 @{c.get('user', {}).get('login', '?')} on {c.get('created_at', '')[:10]}\n\n")
                    f.write(f"{c.get('body', '')}\n\n---\n\n")

            total = len(review_comments) + len([r for r in reviews if r.get('body')]) + len(issue_comments)
            f.write(f"\n---\n*Total: {len(review_comments)} code comments, {len([r for r in reviews if r.get('body')])} reviews, {len(issue_comments)} discussion comments*\n")

        # Create symlink in repo
        repo_path = session_path / 'repo'
        if repo_path.exists():
            symlink_path = repo_path / 'PR_DISCUSSION.md'
            if symlink_path.exists():
                symlink_path.unlink()
            symlink_path.symlink_to('../PR_DISCUSSION.md')

        reviews_with_body = [r for r in reviews if r.get('body')]
        return {
            'review_comments': len(review_comments),
            'reviews': len(reviews_with_body),
            'issue_comments': len(issue_comments)
        }

    def refresh_pr_discussion(self, session_path):
        """Refresh PR comments and discussions"""
        import re
        try:
            # Get PR info from session
            pr_number = None
            repo_owner = None
            repo_name = None

            session_json = session_path / 'session.json'
            info_file = session_path / 'session-info.txt'

            # Try V2 format first
            if session_json.exists():
                with open(session_json) as f:
                    content = f.read().strip()
                if content:
                    data = json.loads(content)
                    pr_info = data.get('pr', {})
                    pr_number = pr_info.get('number')
                    project = data.get('project', '')
                    match = re.search(r'github\.com/([^/]+)/([^/]+)', project)
                    if match:
                        repo_owner = match.group(1)
                        repo_name = match.group(2).replace('.git', '')

            # Fall back to V1 format
            if not pr_number and info_file.exists():
                content = info_file.read_text()
                match = re.search(r'PR #(\d+)', content)
                if match:
                    pr_number = match.group(1)
                match = re.search(r'Repository:\s*([^\n]+)', content)
                if match:
                    repo_str = match.group(1).strip()
                    if '/' in repo_str:
                        parts = repo_str.split('/')
                        if len(parts) >= 2:
                            repo_owner = parts[-2]
                            repo_name = parts[-1].replace('.git', '')

            if not all([pr_number, repo_owner, repo_name]):
                self.send_error(400, 'Could not determine PR info')
                return

            counts = self._do_refresh_discussion(session_path, repo_owner, repo_name, pr_number)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'refreshed',
                **counts
            }).encode())

        except Exception as e:
            self.send_error(500, str(e))

    def fix_finding(self, session_path, finding_data, fix_all):
        """Launch Claude to fix a finding or all findings"""
        import subprocess
        import datetime

        try:
            repo_path = session_path / 'repo'
            if not repo_path.exists():
                self.send_error(400, 'Session repo not found (may be archived)')
                return

            # Create logs directory
            logs_dir = session_path / 'logs'
            logs_dir.mkdir(exist_ok=True)
            log_file = logs_dir / f"terminal-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.log"

            if fix_all:
                prompt = """FIX ALL FINDINGS MODE:
1. Read REVIEW.md and identify all open findings
2. Work through each finding systematically
3. After fixing each one, update its status in REVIEW.md
4. When done, summarize what was fixed

DO NOT COMMIT - user will test and commit manually."""
            else:
                finding = finding_data
                prompt = f"""FIX SINGLE FINDING:

**Finding #{finding.get('number', '?')}: {finding.get('title', 'Unknown')}**

Location: `{finding.get('file', '')}:{finding.get('line', '')}`

**Problem:** {finding.get('problem', 'See REVIEW.md')}

**Impact:** {finding.get('impact', '')}

**Suggested Fix:** {finding.get('suggested', '')}

Instructions:
1. Navigate to the file and line indicated
2. Understand the context
3. Implement the fix
4. Update REVIEW.md to mark this finding as fixed

DO NOT COMMIT - user will test and commit manually."""

            # Run claude directly — use '--' to end options so prompt isn't consumed by --add-dir (variadic)
            escaped_prompt = prompt.replace("'", "'\\''")
            claude_cmd = f"direnv allow '{repo_path}/.envrc' 2>/dev/null; cd '{repo_path}' && claude --add-dir '{session_path}' -- '{escaped_prompt}'"

            session_name = session_path.name

            # Try iTerm2 first
            if Path('/Applications/iTerm.app').exists():
                script = f'''
tell application "iTerm"
    activate
    if (count of windows) = 0 then
        create window with default profile
    end if
    tell current window
        create tab with default profile
        tell current session
            set name to "🔧 Fix: {session_name}"
            write text "{claude_cmd}"
        end tell
    end tell
end tell
'''
            else:
                script = f'''
tell application "Terminal"
    activate
    do script "{claude_cmd}"
end tell
'''
            subprocess.run(['osascript', '-e', script], capture_output=True, text=True)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'started',
                'mode': 'fix_all' if fix_all else 'fix_one',
                'log_file': str(log_file)
            }).encode())

        except Exception as e:
            self.send_error(500, str(e))

    def import_pr_comments(self, session_path):
        """Fetch PR comments and add them as findings to REVIEW.md"""
        import subprocess
        import re

        try:
            # Get PR info from session (try V2 then V1)
            pr_number = None
            owner = None
            repo = None

            session_json = session_path / 'session.json'
            info_file = session_path / 'session-info.txt'

            # Try V2 format first
            if session_json.exists():
                try:
                    content = session_json.read_text().strip()
                    if content:
                        data = json.loads(content)
                        pr_info = data.get('pr', {})
                        pr_number = pr_info.get('number')
                        project = data.get('project', '')
                        match = re.search(r'github\.com/([^/]+)/([^/]+)', project)
                        if match:
                            owner = match.group(1)
                            repo = match.group(2).replace('.git', '')
                except:
                    pass

            # Fall back to V1 format (session-info.txt)
            if not pr_number and info_file.exists():
                content = info_file.read_text()
                # Extract PR number from "PR #930:" pattern
                match = re.search(r'PR #(\d+)', content)
                if match:
                    pr_number = match.group(1)
                # Extract repo from "Repository: org/repo" or URL pattern
                match = re.search(r'Repository:\s*([^\n]+)', content)
                if match:
                    repo_str = match.group(1).strip()
                    # Handle "org/repo" format
                    if '/' in repo_str and 'github.com' not in repo_str:
                        parts = repo_str.split('/')
                        if len(parts) >= 2:
                            owner = parts[0]
                            repo = parts[1].replace('.git', '')
                    # Handle full URL
                    elif 'github.com' in repo_str:
                        url_match = re.search(r'github\.com/([^/]+)/([^/\s]+)', repo_str)
                        if url_match:
                            owner = url_match.group(1)
                            repo = url_match.group(2).replace('.git', '')

            if not all([pr_number, owner, repo]):
                self.send_error(400, f'Could not determine PR info: pr={pr_number}, owner={owner}, repo={repo}')
                return

            # Fetch review comments
            result = subprocess.run(
                ['gh', 'api', f'repos/{owner}/{repo}/pulls/{pr_number}/comments', '--paginate'],
                capture_output=True, text=True
            )
            review_comments = json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else []

            # Read existing REVIEW.md to check for duplicates
            review_file = session_path / 'REVIEW.md'
            if not review_file.exists():
                review_file = session_path / 'repo' / 'REVIEW.md'
            existing_content = review_file.read_text() if review_file.exists() else ''

            # Build new findings from comments
            new_findings = []
            finding_num = len(re.findall(r'#### Finding #\d+', existing_content)) + 1

            for comment in review_comments:
                body = comment.get('body', '')
                path = comment.get('path', '')
                line = comment.get('line') or comment.get('original_line', 0)
                author = comment.get('user', {}).get('login', 'unknown')

                # Skip if already in REVIEW.md
                snippet = body[:50].replace('\n', ' ')
                if snippet in existing_content:
                    continue

                new_findings.append({
                    'number': finding_num,
                    'title': f'PR Comment by @{author}',
                    'file': path,
                    'line': line,
                    'body': body,
                    'author': author,
                    'source': 'pr_comment'
                })
                finding_num += 1

            # Append new findings to REVIEW.md
            if new_findings:
                with open(review_file, 'a') as f:
                    f.write('\n\n---\n\n## Imported PR Comments\n\n')
                    for finding in new_findings:
                        f.write(f"#### Finding #{finding['number']}: {finding['title']}\n\n")
                        f.write(f"📍 **Location:** `{finding['file']}:{finding['line']}`\n\n")
                        f.write(f"**Source:** PR comment by @{finding['author']}\n\n")
                        f.write(f"**Comment:**\n{finding['body']}\n\n")
                        f.write("**Status:** ⚠️ Open\n\n")

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'imported',
                'new_findings': len(new_findings),
                'total_comments': len(review_comments)
            }).encode())

        except Exception as e:
            self.send_error(500, str(e))

    def refresh_pr(self, session_path, mode, force=False):
        """Refresh PR: fetch new commits, archive review, create re-review instructions,
        refresh discussion, then launch agent — matching terminal's refresh_pr_session flow."""
        import subprocess
        import re
        import datetime
        import shutil

        try:
            repo_path = session_path / 'repo'
            if not repo_path.exists():
                self.send_error(400, 'Repo not found (session may be archived)')
                return

            # --- Get PR info from session (try V2 then V1) ---
            session_json = session_path / 'session.json'
            info_file = session_path / 'session-info.txt'

            pr_number = None
            pr_base = 'main'
            repo_owner = None
            repo_name = None

            if session_json.exists():
                try:
                    content = session_json.read_text().strip()
                    if content:
                        data = json.loads(content)
                        pr_number = data.get('pr', {}).get('number')
                        pr_base = data.get('pr', {}).get('base', 'main')
                        project = data.get('project', '')
                        match = re.search(r'github\.com/([^/]+)/([^/]+)', project)
                        if match:
                            repo_owner = match.group(1)
                            repo_name = match.group(2).replace('.git', '')
                except:
                    pass

            if not pr_number and info_file.exists():
                content = info_file.read_text()
                match = re.search(r'PR #(\d+)', content)
                if match:
                    pr_number = match.group(1)
                match = re.search(r'Branch:.*→\s*(\S+)', content)
                if match:
                    pr_base = match.group(1)
                match = re.search(r'Repository:\s*([^\n]+)', content)
                if match:
                    repo_str = match.group(1).strip()
                    if '/' in repo_str:
                        parts = repo_str.split('/')
                        if len(parts) >= 2:
                            repo_owner = parts[-2]
                            repo_name = parts[-1].replace('.git', '')

            if not pr_number:
                self.send_error(400, 'Could not find PR number')
                return

            # --- Step 1: Get current commit and fetch latest PR ---
            old_commit = subprocess.run(
                ['git', 'rev-parse', 'HEAD'],
                cwd=str(repo_path), capture_output=True, text=True
            ).stdout.strip()

            fetch_result = subprocess.run(
                ['git', 'fetch', 'origin', f'pull/{pr_number}/head:pr-{pr_number}-new'],
                cwd=str(repo_path), capture_output=True, text=True
            )
            if fetch_result.returncode != 0:
                self.send_error(500, f'Git fetch failed: {fetch_result.stderr.strip()}')
                return

            new_commit = subprocess.run(
                ['git', 'rev-parse', f'pr-{pr_number}-new'],
                cwd=str(repo_path), capture_output=True, text=True
            ).stdout.strip()

            # --- Step 2: Check if there are new commits ---
            if old_commit == new_commit and not force:
                # Clean up the temporary branch
                subprocess.run(['git', 'branch', '-D', f'pr-{pr_number}-new'],
                               cwd=str(repo_path), capture_output=True, text=True)
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'status': 'up_to_date',
                    'message': 'PR is already up to date (no new commits)'
                }).encode())
                return

            if old_commit == new_commit:
                # Force mode: no new commits but proceed anyway
                # Clean up temp branch since there's nothing to checkout
                subprocess.run(['git', 'branch', '-D', f'pr-{pr_number}-new'],
                               cwd=str(repo_path), capture_output=True, text=True)
                new_commits_text = '(no new commits — forced re-review)'
                commit_count = 0
                changes_since = ''
            else:
                # Normal flow: new commits exist
                log_result = subprocess.run(
                    ['git', 'log', '--oneline', f'{old_commit}..{new_commit}'],
                    cwd=str(repo_path), capture_output=True, text=True
                )
                new_commits_text = log_result.stdout.strip()
                commit_count = len([l for l in new_commits_text.split('\n') if l.strip()]) if new_commits_text else 0

                # Checkout new branch, replace old
                subprocess.run(['git', 'checkout', f'pr-{pr_number}-new'],
                               cwd=str(repo_path), capture_output=True, text=True)
                subprocess.run(['git', 'branch', '-D', f'pr-{pr_number}'],
                               cwd=str(repo_path), capture_output=True, text=True)
                subprocess.run(['git', 'branch', '-m', f'pr-{pr_number}'],
                               cwd=str(repo_path), capture_output=True, text=True)

                # Get diff stats (changes since last review)
                changes_since = subprocess.run(
                    ['git', 'diff', '--stat', f'{old_commit}...pr-{pr_number}'],
                    cwd=str(repo_path), capture_output=True, text=True
                ).stdout.strip()

            # --- Step 4: Update session-info.txt ---
            if info_file.exists():
                with open(info_file, 'a') as f:
                    f.write(f"\nREFRESHED: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                    f.write(f"Previous commit: {old_commit}\n")
                    f.write(f"New commit: {new_commit}\n")
                    f.write(f"New commits: {commit_count}\n")

            # --- Step 5: Archive old REVIEW.md ---
            version = 1
            while (session_path / f'REVIEW-v{version}.md').exists():
                version += 1

            review_file = session_path / 'REVIEW.md'
            if review_file.exists() and review_file.stat().st_size > 0:
                shutil.copy2(str(review_file), str(session_path / f'REVIEW-v{version}.md'))

            next_version = version + 1
            today = datetime.datetime.now().strftime('%Y-%m-%d')

            # --- Step 6: Create RE-REVIEW.md with instructions ---
            rereview_content = f"""# Re-Review: v{next_version}

## What Changed

| Info | Value |
|------|-------|
| **Previous** | v{version} (commit `{old_commit[:8]}`) |
| **Current** | v{next_version} (commit `{new_commit[:8]}`) |
| **New Commits** | {commit_count} |

### New Commits
```
{new_commits_text}
```

### Files Changed Since Last Review
```
{changes_since}
```

---

## Re-Review Instructions

**Update REVIEW.md in-place. Do NOT append sections.**

### 1. Check Each Open Finding
For each finding in "Open Findings":
- **Fixed?** → Move to "Resolved Findings", note the fix
- **Still present?** → Keep in place
- **Partially fixed?** → Update the description

### 2. Update the Tracker Table
```markdown
| ID | Finding | Severity | Status | Since |
|----|---------|----------|--------|-------|
| 1 | Null check missing | 🔴 Critical | ✅ Fixed | v1→v{next_version} |
| 2 | SQL injection | 🟠 High | ⚠️ Open | v1 |
| 3 | New issue found | 🟡 Medium | ⚠️ Open | v{next_version} |
```

### 3. Check for New Issues
Review the new commits for any NEW problems introduced.
Add new findings with "Since: v{next_version}"

### 4. Update Review History (IMPORTANT!)
The Review History table MUST have a new row for this version. Find the table that looks like:
```markdown
## Review History

| Version | Date | Commit | Action |
|---------|------|--------|--------|
| v1 | 2026-01-27 | e627b8f | Initial review - Approved |
```

ADD a new row (do NOT replace existing rows):
```markdown
| v{next_version} | {today} | {new_commit[:8]} | Re-review: X fixed, Y new issues |
```

### 5. Update Verdict
Re-evaluate based on current state of ALL findings (fixed + remaining + new).

---

**CRITICAL: The Review History table must show ALL versions (v1, v2, etc). Do NOT remove previous rows.**

**BEGIN: Read REVIEW.md, check findings against new code, update in-place.**
"""
            with open(repo_path / 'RE-REVIEW.md', 'w') as f:
                f.write(rereview_content)

            # --- Step 7: Update CLAUDE.md with re-review notice ---
            claude_md = repo_path / 'CLAUDE.md'
            if claude_md.exists():
                original = claude_md.read_text()
                # Remove any previous re-review notice
                cleaned = re.sub(r'# ⚠️ RE-REVIEW MODE.*?---\n\n', '', original, flags=re.DOTALL)

                notice = f"""# ⚠️ RE-REVIEW MODE (v{next_version})

**PR updated: {commit_count} new commit(s) since last review.**

## What to do:
1. Read `RE-REVIEW.md` for what changed
2. Update `REVIEW.md` **in-place** (don't append sections)
3. Move fixed items to "Resolved Findings" section
4. Add any new issues found in the new commits
5. **IMPORTANT**: Add a new row to the Review History table for v{next_version}

## Review History Must Show:
- v1: Initial review
- v{next_version}: This re-review (add this row!)

---

"""
                with open(claude_md, 'w') as f:
                    f.write(notice + cleaned)

            # --- Step 8: Refresh PR discussion/comments ---
            discussion_counts = None
            if repo_owner and repo_name:
                try:
                    discussion_counts = self._do_refresh_discussion(session_path, repo_owner, repo_name, pr_number)
                except:
                    pass  # Don't fail if discussion refresh fails

            # --- Step 9: Launch agent in terminal ---
            logs_dir = session_path / 'logs'
            logs_dir.mkdir(exist_ok=True)
            log_file = logs_dir / f"terminal-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
            session_name = session_path.name

            prompt = f"RE-REVIEW MODE: PR has been updated with {commit_count} new commit(s). Read RE-REVIEW.md for what changed, then update REVIEW.md in-place."

            # Run claude directly (not via script(1) — script swallows the prompt argument)
            escaped_prompt = prompt.replace("'", "'\\''")
            if mode == 'acr+claude':
                claude_cmd = f"direnv allow '{repo_path}/.envrc' 2>/dev/null; cd '{repo_path}' && echo '=== Running ACR ===' && acr -r 5 -a claude -b {pr_base} --local > '{session_path}/ACR_REVIEW.md' 2>&1 && echo '=== Starting Claude ===' && claude --add-dir '{session_path}' -- '{escaped_prompt}'"
            else:
                claude_cmd = f"direnv allow '{repo_path}/.envrc' 2>/dev/null; cd '{repo_path}' && claude --add-dir '{session_path}' -- '{escaped_prompt}'"

            if Path('/Applications/iTerm.app').exists():
                script = f'''
tell application "iTerm"
    activate
    if (count of windows) = 0 then
        create window with default profile
    end if
    tell current window
        create tab with default profile
        tell current session
            set name to "🔄 Re-review: {session_name}"
            write text "{claude_cmd}"
        end tell
    end tell
end tell
'''
            else:
                script = f'''
tell application "Terminal"
    activate
    do script "{claude_cmd}"
end tell
'''
            result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
            osascript_error = result.stderr if result.returncode != 0 else None

            # --- Step 10: Update session.json ---
            if session_json.exists():
                try:
                    with open(session_json) as f:
                        sdata = json.load(f)
                    sdata['terminal'] = {
                        'log_file': str(log_file),
                        'tab_name': f"🔄 Re-review: {session_name}",
                        'started': datetime.datetime.now().isoformat()
                    }
                    if 'history' not in sdata:
                        sdata['history'] = []
                    sdata['history'].append({
                        'timestamp': datetime.datetime.now().isoformat(),
                        'action': 'refresh_pr_started',
                        'mode': mode,
                        'source': 'dashboard',
                        'old_commit': old_commit,
                        'new_commit': new_commit,
                        'commit_count': commit_count
                    })
                    with open(session_json, 'w') as f:
                        json.dump(sdata, f, indent=2)
                except:
                    pass

            terminal_marker = session_path / '.terminal_log'
            terminal_marker.write_text(str(log_file))

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            response = {
                'status': 'started',
                'mode': mode,
                'pr': str(pr_number),
                'commits': commit_count,
                'version': next_version,
                'log_file': str(log_file)
            }
            if osascript_error:
                response['osascript_error'] = osascript_error
            if discussion_counts:
                response['discussion'] = discussion_counts
            self.wfile.write(json.dumps(response).encode())

        except Exception as e:
            self.send_error(500, str(e))

    def get_pr_info(self, pr_url):
        """Fetch PR info for Jira auto-detection"""
        import subprocess
        import re
        try:
            if not pr_url:
                self.send_error(400, 'Missing PR URL')
                return

            # Parse PR URL
            match = re.match(r'https://github\.com/([^/]+)/([^/]+)/pull/(\d+)', pr_url)
            if not match:
                self.send_error(400, 'Invalid PR URL format')
                return

            owner = match.group(1)
            repo = match.group(2)
            pr_number = match.group(3)

            # Fetch PR info via gh cli
            result = subprocess.run(
                ['gh', 'pr', 'view', pr_number, '--repo', f'{owner}/{repo}',
                 '--json', 'title,headRefName,baseRefName,author'],
                capture_output=True,
                text=True,
                timeout=30
            )

            if result.returncode != 0:
                self.send_error(500, f'Failed to fetch PR: {result.stderr}')
                return

            pr_data = json.loads(result.stdout)
            branch = pr_data.get('headRefName', '')

            # Extract Jira ticket from branch name
            detected_jira = None
            if branch:
                # Try start of branch first (e.g., HB-404-fix-login)
                jira_match = re.match(r'^([A-Za-z]+-\d+)', branch)
                if jira_match:
                    detected_jira = jira_match.group(1).upper()
                else:
                    # Try anywhere in branch name
                    jira_match = re.search(r'([A-Za-z]+-\d+)', branch)
                    if jira_match:
                        detected_jira = jira_match.group(1).upper()

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'pr_number': pr_number,
                'title': pr_data.get('title', ''),
                'branch': branch,
                'base': pr_data.get('baseRefName', ''),
                'author': pr_data.get('author', {}).get('login', ''),
                'detected_jira': detected_jira
            }).encode())

        except subprocess.TimeoutExpired:
            self.send_error(500, 'PR fetch timed out')
        except Exception as e:
            self.send_error(500, str(e))

    def create_new_session(self, mode, url, jira=None, focus=None):
        """Create a new session via the sandbox script"""
        import subprocess
        import re
        import datetime

        try:
            if not mode or not url:
                self.send_error(400, 'Missing mode or URL')
                return

            if mode == 'development' and not jira:
                self.send_error(400, 'Development mode requires Jira ticket')
                return

            is_pr_url = '/pull/' in url

            if mode == 'review' and not is_pr_url:
                self.send_error(400, 'Review mode requires a PR URL')
                return

            # Build command to run sandbox in non-interactive mode
            env = os.environ.copy()
            env['SANDBOX_MODE'] = mode
            env['SANDBOX_URL'] = url
            if jira:
                env['SANDBOX_JIRA'] = jira
            if focus:
                env['SANDBOX_FOCUS'] = focus

            # Find the sandbox script - it's in the same directory as this server script
            sandbox_path = Path(SESSIONS_DIR) / 'sandbox'
            if not sandbox_path.exists():
                sandbox_path = Path(__file__).parent / 'sandbox'

            result = subprocess.run(
                [str(sandbox_path), '--create-session'],
                env=env,
                capture_output=True,
                text=True,
                timeout=120
            )

            if result.returncode != 0:
                self.send_error(500, f'Session creation failed: {result.stderr}')
                return

            session_name = result.stdout.strip().split('\n')[-1]

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'created',
                'session': session_name,
                'mode': mode
            }).encode())

        except subprocess.TimeoutExpired:
            self.send_error(500, 'Session creation timed out')
        except Exception as e:
            self.send_error(500, str(e))

    def run_application(self, session_path):
        """Run the application in a new terminal"""
        import subprocess

        try:
            repo_path = session_path / 'repo'
            if not repo_path.exists():
                self.send_error(400, 'Repo not found (session may be archived)')
                return

            # Load project config
            projects_config = Path.home() / '.sandbox' / 'projects.json'
            run_cmd = None

            # Get project URL from session
            session_json = session_path / 'session.json'
            project_url = ''
            if session_json.exists():
                with open(session_json) as f:
                    content = f.read().strip()
                if content:
                    data = json.loads(content)
                    project_url = data.get('project', '')

            # Extract repo key
            import re
            match = re.search(r'(github\\.com/[^/]+/[^/]+)', project_url)
            repo_key = match.group(1) if match else ''

            if projects_config.exists() and repo_key:
                with open(projects_config) as f:
                    projects = json.load(f)
                config = projects.get(repo_key, {})
                run_cmd = config.get('run_cmd')

            # If no config, try to detect from package.json
            if not run_cmd:
                package_json = repo_path / 'package.json'
                if package_json.exists():
                    with open(package_json) as f:
                        pkg = json.load(f)
                    scripts = pkg.get('scripts', {})
                    if 'dev' in scripts:
                        run_cmd = 'npm run dev'
                    elif 'start' in scripts:
                        run_cmd = 'npm start'

            if not run_cmd:
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'status': 'needs_config',
                    'message': 'No run command configured for this project'
                }).encode())
                return

            # Check if already running
            running_file = Path(SESSIONS_DIR) / '.running_apps.json'
            running = {}
            if running_file.exists():
                with open(running_file) as f:
                    running = json.load(f)

            if repo_key in running and running[repo_key] != session_path.name:
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'status': 'already_running',
                    'other_session': running[repo_key],
                    'message': f'App already running in session: {running[repo_key]}'
                }).encode())
                return

            # Mark as running
            if repo_key:
                running[repo_key] = session_path.name
                with open(running_file, 'w') as f:
                    json.dump(running, f)

            session_name = session_path.name

            if Path('/Applications/iTerm.app').exists():
                script = f'''
tell application "iTerm"
    activate
    if (count of windows) = 0 then
        create window with default profile
    end if
    tell current window
        create tab with default profile
        tell current session
            set name to "▶️ App: {session_name}"
            write text "cd '{repo_path}' && {run_cmd}"
        end tell
    end tell
end tell
'''
            else:
                script = f'''
tell application "Terminal"
    activate
    do script "cd '{repo_path}' && {run_cmd}"
end tell
'''
            subprocess.run(['osascript', '-e', script], capture_output=True, text=True)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'started',
                'command': run_cmd
            }).encode())

        except Exception as e:
            self.send_error(500, str(e))

    def commit_changes(self, session_path, message):
        """Show git status and optionally commit"""
        import subprocess

        try:
            repo_path = session_path / 'repo'
            if not repo_path.exists():
                self.send_error(400, 'Repo not found (session may be archived)')
                return

            # Get git status
            result = subprocess.run(
                ['git', 'status', '--porcelain'],
                cwd=str(repo_path),
                capture_output=True,
                text=True
            )

            if not result.stdout.strip():
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'status': 'no_changes',
                    'message': 'No changes to commit'
                }).encode())
                return

            # If no message provided, return status for preview
            if not message:
                diff_result = subprocess.run(
                    ['git', 'diff', '--stat', 'HEAD'],
                    cwd=str(repo_path),
                    capture_output=True,
                    text=True
                )

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'status': 'preview',
                    'changes': result.stdout.strip(),
                    'diff_stat': diff_result.stdout.strip()
                }).encode())
                return

            # Stage and commit
            subprocess.run(['git', 'add', '-A'], cwd=str(repo_path))
            result = subprocess.run(
                ['git', 'commit', '-m', message],
                cwd=str(repo_path),
                capture_output=True,
                text=True
            )

            if result.returncode != 0:
                self.send_error(500, f'Commit failed: {result.stderr}')
                return

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'committed',
                'message': message
            }).encode())

        except Exception as e:
            self.send_error(500, str(e))

    def send_sessions_list(self):
        import re, datetime, time
        sessions = []
        now = time.time()
        for entry in Path(SESSIONS_DIR).iterdir():
            if not entry.is_dir() or entry.name.startswith('.'):
                continue
            session_json = entry / 'session.json'
            info_file = entry / 'session-info.txt'

            info = {}

            # V2 format: session.json (but fall back to v1 if empty/invalid)
            if session_json.exists():
                info = self.parse_session_json(session_json)

            # V1 format: session-info.txt (fallback if v2 missing or invalid)
            if not info and info_file.exists():
                info = self.parse_session_info(info_file)
                # Detect session type from folder name for v1
                if entry.name.startswith('pr-'):
                    info['session_type'] = 'review'
                elif entry.name.startswith('dev-'):
                    info['session_type'] = 'development'
                elif entry.name.startswith('inv-'):
                    info['session_type'] = 'investigation'
                else:
                    info['session_type'] = 'unknown'

            # Skip if we couldn't get any info
            if not info:
                continue

            # Detect session type from folder name if mode is unknown/missing
            if info.get('session_type', 'unknown') == 'unknown' or info.get('mode', 'unknown') == 'unknown':
                if entry.name.startswith('pr-'):
                    info['session_type'] = info['mode'] = 'review'
                elif entry.name.startswith('dev-'):
                    info['session_type'] = info['mode'] = 'development'
                elif entry.name.startswith('inv-'):
                    info['session_type'] = info['mode'] = 'investigation'

            info['name'] = entry.name
            # Check for output files in both root and repo/ folder
            def has_file(name):
                root = entry / name
                repo = entry / 'repo' / name
                return (root.exists() and root.stat().st_size > 0) or (repo.exists() and repo.stat().st_size > 0)
            info['has_review'] = has_file('REVIEW.md')
            info['has_findings'] = has_file('FINDINGS.md')
            info['has_devlog'] = has_file('DEVLOG.md')
            info['archived'] = not (entry / 'repo').exists()

            # Check for archived review versions (REVIEW-v1.md, REVIEW-v2.md, etc.)
            review_versions = []
            for f in entry.glob('REVIEW-v*.md'):
                if f.stat().st_size > 0:
                    version = f.stem.replace('REVIEW-', '')
                    review_versions.append(version)
            info['review_versions'] = sorted(review_versions)

            # Check for RE-REVIEW.md (indicates re-review in progress)
            info['has_rereview'] = (entry / 'repo' / 'RE-REVIEW.md').exists()

            # Check terminal status
            info['has_terminal'] = self.check_terminal_active(entry)

            # --- Stable timestamps ---
            # Parse creation time from folder name (e.g. pr-name-20260219-172956)
            created_ts = 0
            m = re.search(r'(\d{8})-(\d{6})$', entry.name)
            if m:
                try:
                    dt = datetime.datetime.strptime(m.group(1) + m.group(2), '%Y%m%d%H%M%S')
                    created_ts = dt.timestamp()
                except ValueError:
                    pass
            if not created_ts:
                # Fallback: use created field from session-info or session.json
                created_str = info.get('created', '')
                if created_str:
                    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S'):
                        try:
                            created_ts = datetime.datetime.strptime(created_str[:19], fmt).timestamp()
                            break
                        except ValueError:
                            pass
            if not created_ts:
                created_ts = entry.stat().st_ctime
            info['created_ts'] = created_ts

            # Last activity: mtime of the directory
            info['last_activity_ts'] = entry.stat().st_mtime

            # Stale: no activity in 3+ days (and not archived)
            days_inactive = (now - info['last_activity_ts']) / 86400
            info['stale'] = days_inactive > 3 and not info['archived']

            sessions.append((entry, info))

        # Check PR states in parallel (uncached ones only)
        from concurrent.futures import ThreadPoolExecutor
        pr_sessions = [(entry, info) for entry, info in sessions
                       if info.get('pr') and info.get('session_type') == 'review']
        if pr_sessions:
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {pool.submit(self._get_pr_state, entry, info): info
                           for entry, info in pr_sessions}
                for future in futures:
                    info = futures[future]
                    try:
                        info['pr_state'] = future.result(timeout=6)
                    except Exception:
                        pass

        # Unwrap (entry, info) tuples
        sessions = [info for _, info in sessions]

        # Sort: live terminal first, then by creation date (newest first)
        # Archived always last
        def sort_key(s):
            archived = 1 if s.get('archived') else 0
            live = 0 if s.get('has_terminal') else 1
            return (archived, live, -s.get('created_ts', 0))
        sessions.sort(key=sort_key)

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(sessions).encode())

    # Cache PR state checks (module-level would be better but this works in single-process server)
    _pr_state_cache = {}  # {session_name: {'state': 'MERGED', 'checked': timestamp}}

    def _get_pr_state(self, session_path, info):
        """Get PR state (OPEN/MERGED/CLOSED), cached to avoid hammering GitHub API"""
        import subprocess, time
        session_name = session_path.name
        now = time.time()

        # Check cache: terminal states never change, open states re-check every 5 min
        cached = self._pr_state_cache.get(session_name)
        if cached:
            state = cached['state']
            if state in ('MERGED', 'CLOSED'):
                return state
            if now - cached['checked'] < 300:  # 5 min TTL for OPEN
                return state

        # Extract repo from session info
        repo = info.get('repository', '')
        pr_num = info.get('pr', '')
        if not pr_num or not repo:
            return None

        # Parse org/repo — may be a URL or plain "org/repo" slug
        import re
        repo_match = re.search(r'github\.com[:/]([^/]+/[^/\s]+?)(?:\.git)?$', repo)
        repo_slug = repo_match.group(1) if repo_match else repo.strip().rstrip('/')
        if '/' not in repo_slug:
            return None

        try:
            result = subprocess.run(
                ['gh', 'pr', 'view', str(pr_num), '--repo', repo_slug, '--json', 'state', '-q', '.state'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                state = result.stdout.strip()  # OPEN, MERGED, or CLOSED
                self._pr_state_cache[session_name] = {'state': state, 'checked': now}
                return state
        except Exception:
            pass
        return None

    def parse_session_json(self, path):
        """Parse V2 session.json format"""
        import re
        try:
            with open(path) as f:
                content = f.read().strip()
            # Return None for empty or whitespace-only files
            if not content:
                return None
            data = json.loads(content)

            info = {
                'session_type': data.get('mode', 'unknown'),
                'mode': data.get('mode', 'unknown'),
                'project': data.get('project', ''),
                'created': data.get('created', ''),
                'status': data.get('status', 'active'),
            }

            # Extract mode-specific fields
            mode = data.get('mode', '')
            if mode == 'review':
                pr = data.get('pr', {})
                # If PR data is missing, return None to trigger fallback to session-info.txt
                if not pr or not pr.get('number'):
                    return None
                info['pr'] = pr.get('number', '')
                info['pr_title'] = pr.get('title', '')
                info['author'] = pr.get('author', '')
                info['branch'] = f"{pr.get('head', '')} → {pr.get('base', '')}" if pr.get('head') else ''
                info['display_title'] = f"PR #{pr.get('number', '')}: {pr.get('title', '')}"
                info['url'] = pr.get('url', '')
                # Derive repository from project URL or PR URL
                project_url = data.get('project', '')
                if project_url:
                    info['repository'] = project_url
                elif pr.get('url'):
                    info['repository'] = re.sub(r'/pull/\d+.*$', '', pr['url'])
                # Extract Jira ticket from branch name or PR title
                head_branch = pr.get('head', '')
                pr_title = pr.get('title', '')
                jira_match = re.search(r'([A-Z]{2,}-\d+)', head_branch) or re.search(r'([A-Z]{2,}-\d+)', pr_title)
                if jira_match:
                    info['jira'] = jira_match.group(1)
            elif mode == 'development':
                jira = data.get('jira', {})
                info['jira'] = jira.get('ticket', '')
                info['summary'] = jira.get('summary', '')
                info['branch'] = data.get('branch', '')
                ticket = jira.get('ticket', '')
                summary = jira.get('summary', '')
                info['display_title'] = f"{ticket}: {summary}" if summary else f"Dev: {ticket}"
            elif mode == 'investigation':
                info['focus'] = data.get('focus', '')
                info['display_title'] = f"Investigation: {data.get('focus', '')[:50]}"

            # Override display_title if custom one was set
            if data.get('display_title'):
                info['display_title'] = data['display_title']

            # Terminal info
            terminal = data.get('terminal', {})
            if terminal:
                info['terminal_log'] = terminal.get('log_file', '')

            return info
        except Exception as e:
            # Return None on parse error to trigger fallback to session-info.txt
            return None

    def check_terminal_active(self, session_path):
        """Check if session has an active terminal log being written"""
        import time
        log_file = None

        try:
            # Method 1: Check session.json (v2 sessions)
            session_json = session_path / 'session.json'
            if session_json.exists():
                with open(session_json) as f:
                    content = f.read().strip()
                if content:
                    data = json.loads(content)
                    log_file = data.get('terminal', {}).get('log_file', '')

            # Method 2: Check .terminal_log marker file (v1 sessions or fallback)
            if not log_file:
                marker = session_path / '.terminal_log'
                if marker.exists():
                    log_file = marker.read_text().strip()

            # Method 3: Check logs/ directory for recent log files
            if not log_file or not Path(log_file).exists():
                logs_dir = session_path / 'logs'
                if logs_dir.exists():
                    log_files = sorted(logs_dir.glob('terminal-*.log'), key=lambda x: x.stat().st_mtime, reverse=True)
                    if log_files:
                        log_file = str(log_files[0])

            # Check if log file was modified recently (within 120 seconds)
            if log_file and Path(log_file).exists():
                mtime = Path(log_file).stat().st_mtime
                return (time.time() - mtime) < 120
        except:
            pass
        return False

    def send_terminal_output(self, session_name, lines=100):
        """Stream terminal output from session log file"""
        import re
        session_path = Path(SESSIONS_DIR) / session_name
        content = ""

        try:
            # Try session.json first for log file path
            session_json = session_path / 'session.json'
            log_file = None

            if session_json.exists():
                with open(session_json) as f:
                    content = f.read().strip()
                if content:
                    data = json.loads(content)
                    log_file = data.get('terminal', {}).get('log_file', '')

            # Fallback: look for any log file
            if not log_file or not Path(log_file).exists():
                logs_dir = session_path / 'logs'
                if logs_dir.exists():
                    log_files = sorted(logs_dir.glob('*.log'), key=lambda x: x.stat().st_mtime, reverse=True)
                    if log_files:
                        log_file = str(log_files[0])

            if log_file and Path(log_file).exists():
                with open(log_file, 'r', errors='replace') as f:
                    all_lines = f.readlines()
                    content = ''.join(all_lines[-lines:])
                    # Strip ANSI escape codes for cleaner display
                    # Handle: colors, cursor movement, clearing, etc.
                    content = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', content)  # CSI sequences
                    content = re.sub(r'\x1b\][^\x07]*\x07', '', content)  # OSC sequences (title, etc.)
                    content = re.sub(r'\x1b[()][AB012]', '', content)  # Character set selection
                    content = re.sub(r'\x1b[78DEHM]', '', content)  # Other escape sequences
                    content = re.sub(r'\x0f|\x0e', '', content)  # Shift In/Out
                    content = re.sub(r'\r', '', content)  # Carriage returns
        except Exception as e:
            content = f"Error reading terminal log: {e}"

        self.send_response(200)
        self.send_header('Content-type', 'text/plain; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(content.encode())

    def send_session_details(self, session_name):
        """Get full session details including history"""
        session_path = Path(SESSIONS_DIR) / session_name
        result = {'name': session_name}

        try:
            session_json = session_path / 'session.json'
            info_file = session_path / 'session-info.txt'
            loaded_v2 = False

            # Try V2 format first (session.json)
            if session_json.exists():
                with open(session_json) as f:
                    content = f.read().strip()
                if content:
                    result = json.loads(content)
                    result['name'] = session_name
                    result['format'] = 'v2'
                    loaded_v2 = True

            # Fall back to V1 format (session-info.txt)
            if not loaded_v2 and info_file.exists():
                result = self.parse_session_info(info_file)
                result['name'] = session_name
                result['format'] = 'v1'
        except Exception as e:
            result['error'] = str(e)

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def parse_session_info(self, path):
        import re
        info = {}
        try:
            content = path.read_text()
            lines = content.split('\n')
            in_focus = False
            focus_lines = []

            for line in lines:
                # Parse key: value pairs
                if ':' in line and not line.startswith('=') and not line.startswith('-'):
                    key, _, value = line.partition(':')
                    key = key.strip().lower().replace(' ', '_')
                    value = value.strip()
                    if value:
                        info[key] = value

                # Extract PR number and title from "PR #123: Title here"
                if line.startswith('PR #'):
                    match = re.match(r'PR #(\d+)', line)
                    if match:
                        info['pr'] = match.group(1)
                    parts = line.split(':', 1)
                    if len(parts) > 1:
                        info['pr_title'] = parts[1].strip()

                # Track investigation focus section
                if 'Investigation Focus:' in line:
                    in_focus = True
                    continue
                if in_focus:
                    if line.startswith('===') or line.startswith('---'):
                        in_focus = False
                    elif line.strip() and not line.startswith('-'):
                        focus_lines.append(line.strip())

            if focus_lines:
                info['focus'] = ' '.join(focus_lines)[:100]

            # Extract repo from repository field if URL
            if 'repository' in info and 'github.com' in info['repository']:
                # Handle URLs like https://github.com/org/repo or git@github.com:org/repo
                repo_url = info['repository']
                if not repo_url.startswith('http'):
                    # Convert git@github.com:org/repo to https://github.com/org/repo
                    match = re.match(r'git@github\.com:(.+?)(?:\.git)?$', repo_url)
                    if match:
                        info['repository'] = f"https://github.com/{match.group(1)}"

            # Extract author from PR info line like "Author: John Doe"
            # or from "PR #123: Title by author" patterns
            for line in lines:
                if line.lower().startswith('author:'):
                    info['author'] = line.split(':', 1)[1].strip()
                elif line.lower().startswith('creator:'):
                    info['creator'] = line.split(':', 1)[1].strip()
                elif line.lower().startswith('created by:'):
                    info['author'] = line.split(':', 1)[1].strip()

            # Build display title - use full description, not truncated
            session_type = info.get('type', 'Session')
            jira = info.get('jira', '')
            summary = info.get('summary', '')

            if 'PR' in session_type:
                pr_title = info.get('pr_title', '')
                pr_num = info.get('pr', '')
                if pr_title:
                    info['display_title'] = f"PR #{pr_num}: {pr_title}" if pr_num else f"PR: {pr_title}"
                else:
                    info['display_title'] = f"PR #{pr_num}" if pr_num else "PR Review"
            elif 'Development' in session_type:
                # For development sessions, show Jira ticket and summary
                if jira and summary:
                    info['display_title'] = f"{jira}: {summary}"
                elif jira:
                    info['display_title'] = f"Development: {jira}"
                else:
                    info['display_title'] = "Development"
            else:
                # For investigations, use the focus/description
                focus = info.get('focus', '') or info.get('description', '')
                if focus:
                    info['display_title'] = f"Investigation: {focus}"
                else:
                    info['display_title'] = "Investigation"

            if jira and 'Development' not in session_type:
                info['display_title'] += f" ({jira})"

        except Exception as e:
            info['display_title'] = 'Session'
        return info

    def send_file_content(self, session, file_type, version='current'):
        # Determine filename based on type and version
        if version != 'current' and file_type == 'review':
            # Archived version like REVIEW-v1.md
            filename = f'REVIEW-{version}.md'
        elif file_type == 'review':
            filename = 'REVIEW.md'
        elif file_type == 'findings':
            filename = 'FINDINGS.md'
        elif file_type == 'devlog':
            filename = 'DEVLOG.md'
        else:
            filename = 'REVIEW.md'

        session_path = Path(SESSIONS_DIR) / session
        # Check both root and repo/ folder
        filepath = session_path / filename
        if not filepath.exists() or filepath.stat().st_size == 0:
            filepath = session_path / 'repo' / filename

        content = ''
        if filepath.exists():
            try:
                content = filepath.read_text()
            except:
                pass

        self.send_response(200)
        self.send_header('Content-type', 'text/plain; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(content.encode())

    def send_dashboard(self):
        html = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Sandbox Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        :root {
            --bg-base: #0c0c0e;
            --bg-surface: #141416;
            --bg-elevated: #1c1c20;
            --bg-hover: #222228;
            --bg-active: #1a1a2e;
            --border: #2a2a30;
            --border-subtle: #1e1e24;
            --text-primary: #ededef;
            --text-secondary: #8b8b96;
            --text-tertiary: #56565e;
            --accent: #7c5cfc;
            --accent-dim: #6248d1;
            --accent-bg: rgba(124,92,252,0.1);
            --accent-border: rgba(124,92,252,0.3);
            --green: #3dd68c;
            --green-bg: rgba(61,214,140,0.1);
            --green-border: rgba(61,214,140,0.3);
            --amber: #f0b429;
            --amber-bg: rgba(240,180,41,0.08);
            --red: #e5484d;
            --red-bg: rgba(229,72,77,0.08);
            --blue: #5b9ef0;
            --blue-bg: rgba(91,158,240,0.08);
            --font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
            --font-mono: 'JetBrains Mono', 'SF Mono', monospace;
            --radius-sm: 6px;
            --radius-md: 8px;
            --radius-lg: 12px;
            --shadow-md: 0 4px 24px rgba(0,0,0,0.4);
            --shadow-lg: 0 8px 40px rgba(0,0,0,0.5);
            --transition: 150ms ease;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: var(--font-sans);
            background: var(--bg-base);
            color: var(--text-primary);
            display: flex;
            height: 100vh;
            overflow: hidden;
            -webkit-font-smoothing: antialiased;
        }

        /* ===== SIDEBAR ===== */
        .sidebar {
            width: 300px;
            background: var(--bg-surface);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
        }

        .sidebar-header {
            padding: 16px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .logo {
            font-size: 15px;
            font-weight: 700;
            letter-spacing: -0.3px;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .logo::before {
            content: '';
            width: 20px;
            height: 20px;
            background: linear-gradient(135deg, var(--accent), #a78bfa);
            border-radius: 5px;
            display: block;
        }

        .btn-new {
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 6px 12px;
            background: var(--accent);
            color: #fff;
            border: none;
            border-radius: var(--radius-sm);
            font-size: 13px;
            font-weight: 600;
            font-family: var(--font-sans);
            cursor: pointer;
            transition: background var(--transition), transform var(--transition);
            white-space: nowrap;
        }

        .btn-new:hover { background: var(--accent-dim); transform: translateY(-1px); }

        .btn-new svg {
            width: 14px;
            height: 14px;
            stroke: currentColor;
            stroke-width: 2.5;
            fill: none;
        }

        .sidebar-search {
            padding: 8px 12px;
            border-bottom: 1px solid var(--border-subtle);
        }

        .filter-input {
            width: 100%;
            padding: 8px 10px;
            background: var(--bg-base);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--text-primary);
            font-size: 13px;
            font-family: var(--font-sans);
            outline: none;
            transition: border-color var(--transition);
        }

        .filter-input::placeholder { color: var(--text-tertiary); }
        .filter-input:focus { border-color: var(--accent); }

        .sidebar-body {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
        }

        .sidebar-body::-webkit-scrollbar { width: 4px; }
        .sidebar-body::-webkit-scrollbar-track { background: transparent; }
        .sidebar-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

        .section-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-tertiary);
            padding: 12px 8px 6px;
        }

        .session-item {
            padding: 10px 10px;
            border-radius: var(--radius-md);
            cursor: pointer;
            border: 1px solid transparent;
            transition: all var(--transition);
            margin-bottom: 2px;
        }

        .session-item:hover {
            background: var(--bg-hover);
            border-color: var(--border);
        }

        .session-item.active {
            background: var(--accent-bg);
            border-color: var(--accent-border);
        }

        .session-item .si-title {
            font-weight: 500;
            font-size: 13px;
            color: var(--text-primary);
            margin-bottom: 3px;
            line-height: 1.3;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .session-item .si-title .live-indicator {
            width: 6px;
            height: 6px;
            background: var(--green);
            border-radius: 50%;
            animation: pulse 2s infinite;
            flex-shrink: 0;
        }

        .session-item .si-folder {
            font-size: 11px;
            color: var(--text-tertiary);
            font-family: var(--font-mono);
            margin-bottom: 5px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .session-item .si-tags {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
        }

        .tag {
            font-size: 10px;
            font-weight: 600;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }

        .tag-mode { background: var(--accent-bg); color: var(--accent); }
        .tag-review { background: var(--blue-bg); color: var(--blue); }
        .tag-findings { background: var(--amber-bg); color: var(--amber); }
        .tag-devlog { background: rgba(167,139,250,0.1); color: #a78bfa; }
        .tag-archived { background: rgba(136,136,150,0.1); color: var(--text-tertiary); }
        .tag-terminal { background: var(--green-bg); color: var(--green); }
        .tag-merged { background: rgba(167,139,250,0.15); color: #a78bfa; }
        .tag-closed { background: rgba(255,107,107,0.1); color: #ff6b6b; }
        .tag-stale { background: rgba(136,136,150,0.1); color: var(--text-tertiary); }
        .session-item.dimmed .si-title { opacity: 0.55; }
        .session-item.dimmed .si-folder { opacity: 0.4; }
        .session-item.dimmed:not(.active):hover .si-title { opacity: 0.75; }

        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

        /* ===== MAIN AREA ===== */
        .main {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            min-width: 0;
        }

        /* Session header */
        .session-header {
            padding: 16px 24px 12px;
            border-bottom: 1px solid var(--border);
            background: var(--bg-surface);
            display: none;
        }

        .session-header.visible { display: block; }

        .sh-top {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 8px;
        }

        .sh-title-area { flex: 1; min-width: 0; }

        .sh-title {
            font-size: 18px;
            font-weight: 700;
            color: var(--text-primary);
            letter-spacing: -0.3px;
            line-height: 1.3;
            cursor: pointer;
            padding: 2px 6px;
            margin: -2px -6px;
            border-radius: var(--radius-sm);
            border: 1px solid transparent;
            transition: all var(--transition);
        }

        .sh-title:hover {
            background: var(--bg-hover);
            border-color: var(--border);
        }

        .sh-title-input {
            font-size: 18px;
            font-weight: 700;
            color: var(--text-primary);
            letter-spacing: -0.3px;
            background: var(--bg-base);
            border: 1px solid var(--accent);
            border-radius: var(--radius-sm);
            padding: 2px 6px;
            width: 100%;
            font-family: var(--font-sans);
            outline: none;
        }

        .sh-actions {
            display: flex;
            gap: 6px;
            flex-shrink: 0;
            align-items: center;
        }

        .btn-action {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 6px 10px;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--text-secondary);
            font-size: 12px;
            font-weight: 500;
            font-family: var(--font-sans);
            cursor: pointer;
            transition: all var(--transition);
            white-space: nowrap;
        }

        .btn-action:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
            border-color: #3a3a42;
        }

        .btn-action.primary {
            background: var(--green-bg);
            border-color: var(--green-border);
            color: var(--green);
        }

        .btn-action.primary:hover { background: rgba(61,214,140,0.18); }

        .btn-action.danger {
            color: var(--red);
        }

        .btn-action.danger:hover {
            background: var(--red-bg);
            border-color: rgba(229,72,77,0.3);
        }

        .btn-action.warn {
            color: var(--amber);
        }

        .btn-action.warn:hover {
            background: var(--amber-bg);
            border-color: rgba(240,180,41,0.3);
        }

        .btn-action:disabled {
            opacity: 0.35;
            cursor: not-allowed;
            pointer-events: none;
        }

        .sh-meta {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }

        .sh-link {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            color: var(--blue);
            text-decoration: none;
            padding: 3px 8px;
            background: var(--blue-bg);
            border-radius: var(--radius-sm);
            transition: all var(--transition);
            font-weight: 500;
        }

        .sh-link:hover { background: rgba(91,158,240,0.16); }

        .sh-info {
            font-size: 12px;
            color: var(--text-tertiary);
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .sh-divider {
            width: 1px;
            height: 14px;
            background: var(--border);
        }

        /* ===== TOOLBAR ===== */
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 24px;
            height: 44px;
            border-bottom: 1px solid var(--border);
            background: var(--bg-base);
            flex-shrink: 0;
        }

        .tab-group {
            display: flex;
            gap: 2px;
            height: 100%;
            align-items: stretch;
        }

        .tab {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 14px;
            font-size: 13px;
            font-weight: 500;
            color: var(--text-tertiary);
            background: none;
            border: none;
            border-bottom: 2px solid transparent;
            cursor: pointer;
            font-family: var(--font-sans);
            transition: color var(--transition);
            position: relative;
        }

        .tab:hover { color: var(--text-secondary); }

        .tab.active {
            color: var(--text-primary);
            border-bottom-color: var(--accent);
        }

        .tab .tab-dot {
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: var(--green);
        }

        .toolbar-right {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .version-select {
            background: var(--bg-elevated);
            color: var(--text-secondary);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 4px 8px;
            font-size: 12px;
            font-family: var(--font-sans);
            cursor: pointer;
            outline: none;
        }

        .status-text {
            font-size: 11px;
            color: var(--text-tertiary);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .status-dot {
            width: 6px;
            height: 6px;
            background: var(--green);
            border-radius: 50%;
            animation: pulse 2s infinite;
        }

        .rereview-badge {
            font-size: 11px;
            font-weight: 600;
            padding: 3px 8px;
            background: var(--amber-bg);
            color: var(--amber);
            border-radius: var(--radius-sm);
        }

        /* ===== CONTENT ===== */
        .content {
            flex: 1;
            overflow-y: auto;
            padding: 32px;
        }

        .content::-webkit-scrollbar { width: 6px; }
        .content::-webkit-scrollbar-track { background: transparent; }
        .content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

        .content h1 { font-size: 1.5rem; margin-bottom: 1rem; color: var(--text-primary); letter-spacing: -0.3px; }
        .content h2 { font-size: 1.2rem; margin: 1.8rem 0 0.8rem; color: var(--text-primary); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; letter-spacing: -0.2px; }
        .content h3 { font-size: 1.05rem; margin: 1.2rem 0 0.5rem; color: var(--text-secondary); }
        .content h4 { font-size: 0.95rem; margin: 1rem 0 0.4rem; color: var(--text-primary); }
        .content p { margin-bottom: 1rem; line-height: 1.75; color: var(--text-secondary); }
        .content pre { background: var(--bg-elevated); padding: 16px; border-radius: var(--radius-md); overflow-x: auto; margin: 1rem 0; border: 1px solid var(--border); }
        .content code { font-family: var(--font-mono); font-size: 0.85em; }
        .content p > code, .content li > code { background: var(--bg-elevated); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
        .content ul, .content ol { margin: 1rem 0; padding-left: 1.5rem; }
        .content li { margin-bottom: 0.5rem; color: var(--text-secondary); line-height: 1.6; }
        .content blockquote { border-left: 3px solid var(--accent); padding-left: 1rem; margin: 1rem 0; color: var(--text-tertiary); }
        .content a { color: var(--blue); }
        .content table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
        .content th, .content td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; font-size: 0.9em; }
        .content th { background: var(--bg-elevated); color: var(--text-primary); font-weight: 600; }
        .content td { color: var(--text-secondary); }
        .content img { max-width: 100%; border-radius: var(--radius-md); }

        .terminal-output {
            background: var(--bg-elevated);
            color: var(--green);
            font-family: var(--font-mono);
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
            padding: 16px;
            border-radius: var(--radius-md);
            overflow: auto;
            max-height: calc(100vh - 280px);
            border: 1px solid var(--border);
        }

        /* ===== EMPTY STATE ===== */
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            text-align: center;
            padding: 3rem;
        }

        .empty-icon {
            width: 56px;
            height: 56px;
            background: var(--bg-elevated);
            border-radius: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            margin-bottom: 16px;
            border: 1px solid var(--border);
        }

        .empty-state h2 {
            font-size: 16px;
            font-weight: 600;
            color: var(--text-primary);
            margin-bottom: 6px;
        }

        .empty-state p {
            font-size: 13px;
            color: var(--text-tertiary);
            max-width: 280px;
            line-height: 1.5;
        }

        /* ===== FINDINGS TRACKER ===== */
        .findings-tracker { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
        .ft-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); }
        .ft-title { font-weight: 600; font-size: 13px; }
        .ft-count { font-size: 12px; color: var(--text-tertiary); }
        .ft-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .ft-table th { text-align: left; padding: 6px 12px; color: var(--text-tertiary); font-weight: 500; border-bottom: 1px solid var(--border); }
        .ft-table td { padding: 6px 12px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.04)); }
        .ft-table tr:last-child td { border-bottom: none; }
        .ft-table tr:hover { background: var(--bg-hover); }
        .ft-link { color: var(--text-primary); text-decoration: none; }
        .ft-link:hover { text-decoration: underline; }
        .ft-loc { font-family: 'SF Mono', monospace; font-size: 11px; color: var(--text-secondary); }
        .sev-badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
        .sev-critical { background: rgba(239,68,68,0.15); color: #f87171; }
        .sev-important { background: rgba(251,191,36,0.15); color: #fbbf24; }
        .sev-minor { background: rgba(96,165,250,0.15); color: #60a5fa; }
        .sev-info { background: rgba(148,163,184,0.15); color: #94a3b8; }

        /* ===== FINDING ACTIONS ===== */
        .finding-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }
        .finding-actions { display: flex; gap: 4px; align-items: center; margin-left: 8px; }

        .btn-inline {
            font-size: 11px;
            font-weight: 500;
            padding: 3px 8px;
            border-radius: var(--radius-sm);
            cursor: pointer;
            border: 1px solid var(--border);
            background: var(--bg-elevated);
            color: var(--text-secondary);
            font-family: var(--font-sans);
            transition: all var(--transition);
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }

        .btn-inline:hover { background: var(--bg-hover); color: var(--text-primary); border-color: #3a3a42; }
        .btn-inline.posted { background: var(--green-bg); color: var(--green); border-color: var(--green-border); }
        .btn-inline.error { background: var(--red-bg); color: var(--red); border-color: rgba(229,72,77,0.3); }
        .btn-inline:disabled { opacity: 0.4; cursor: not-allowed; }

        /* ===== TOAST ===== */
        .toast-container {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 1000;
            display: flex;
            flex-direction: column-reverse;
            gap: 8px;
        }

        .toast {
            padding: 10px 16px;
            border-radius: var(--radius-md);
            font-size: 13px;
            font-weight: 500;
            animation: toastIn 0.25s ease;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: var(--shadow-md);
            max-width: 380px;
        }

        .toast.success { background: #0f2a1a; color: var(--green); border: 1px solid var(--green-border); }
        .toast.error { background: #2a0f0f; color: var(--red); border: 1px solid rgba(229,72,77,0.3); }
        .toast.info { background: #0f1a2a; color: var(--blue); border: 1px solid rgba(91,158,240,0.3); }

        @keyframes toastIn { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

        /* ===== MODAL ===== */
        .modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(4px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 200;
            animation: fadeIn 0.15s ease;
        }

        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .modal-box {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-lg);
            padding: 24px;
            max-width: 480px;
            width: 92%;
            box-shadow: var(--shadow-lg);
            animation: modalIn 0.2s ease;
        }

        @keyframes modalIn { from { transform: translateY(12px) scale(0.98); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }

        .modal-box h3 {
            font-size: 16px;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 4px;
            letter-spacing: -0.2px;
        }

        .modal-box .modal-desc {
            font-size: 13px;
            color: var(--text-tertiary);
            margin-bottom: 16px;
            line-height: 1.4;
        }

        .modal-box label {
            display: block;
            margin: 12px 0 4px;
            color: var(--text-secondary);
            font-size: 13px;
            font-weight: 500;
        }

        .modal-box input[type="text"] {
            width: 100%;
            padding: 8px 10px;
            background: var(--bg-base);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--text-primary);
            font-size: 13px;
            font-family: var(--font-sans);
            outline: none;
            transition: border-color var(--transition);
        }

        .modal-box input[type="text"]:focus { border-color: var(--accent); }

        .modal-footer {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 20px;
        }

        .modal-btn {
            padding: 7px 14px;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            font-family: var(--font-sans);
            transition: all var(--transition);
            border: 1px solid var(--border);
            background: var(--bg-elevated);
            color: var(--text-secondary);
        }

        .modal-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

        .modal-btn.primary {
            background: var(--accent);
            color: #fff;
            border-color: var(--accent);
        }

        .modal-btn.primary:hover { background: var(--accent-dim); }
        .modal-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .mode-options {
            display: flex;
            gap: 6px;
            margin: 12px 0;
        }

        .mode-btn {
            flex: 1;
            padding: 10px 12px;
            border-radius: var(--radius-md);
            cursor: pointer;
            border: 1px solid var(--border);
            background: var(--bg-elevated);
            color: var(--text-secondary);
            font-size: 13px;
            font-weight: 500;
            font-family: var(--font-sans);
            text-align: center;
            transition: all var(--transition);
        }

        .mode-btn:hover { border-color: #3a3a42; color: var(--text-primary); }

        .mode-btn.selected, .mode-btn.active {
            background: var(--accent-bg);
            border-color: var(--accent-border);
            color: var(--accent);
        }

        .mode-btn:disabled { opacity: 0.35; cursor: not-allowed; }

        .pr-info-card {
            background: var(--bg-base);
            border: 1px solid var(--border);
            padding: 12px 14px;
            border-radius: var(--radius-md);
            margin-bottom: 12px;
        }

        .pr-info-card .pr-title { font-weight: 600; font-size: 14px; color: var(--text-primary); margin-bottom: 4px; }
        .pr-info-card .pr-meta { font-size: 12px; color: var(--text-tertiary); line-height: 1.5; }

        .success-banner {
            background: var(--green-bg);
            border: 1px solid var(--green-border);
            color: var(--green);
            padding: 10px 14px;
            border-radius: var(--radius-md);
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 12px;
        }

        .jira-detected {
            font-size: 12px;
            color: var(--green);
            margin-bottom: 6px;
        }

        /* ===== KEYBOARD SHORTCUT HINTS ===== */
        kbd {
            display: inline-flex;
            align-items: center;
            padding: 2px 5px;
            font-size: 10px;
            font-family: var(--font-sans);
            background: var(--bg-base);
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--text-tertiary);
            line-height: 1;
            font-weight: 500;
        }

        /* ===== ACTION BAR (replaces FAB) ===== */
        .action-bar {
            display: none;
            align-items: center;
            gap: 6px;
            padding: 8px 24px;
            border-top: 1px solid var(--border);
            background: var(--bg-surface);
            flex-shrink: 0;
            flex-wrap: wrap;
        }

        .action-bar.visible { display: flex; }

        .action-bar .ab-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-tertiary);
            margin-right: 4px;
        }

        .action-bar .ab-divider {
            width: 1px;
            height: 20px;
            background: var(--border);
            margin: 0 4px;
        }
    </style>
</head>
<body>
    <aside class="sidebar">
        <div class="sidebar-header">
            <div class="logo">Sandbox</div>
            <button class="btn-new" onclick="showNewSessionModal()" title="New Session (⌘N)">
                <svg viewBox="0 0 16 16"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
                New
            </button>
        </div>
        <div class="sidebar-search">
            <input type="text" class="filter-input" placeholder="Search sessions..." id="filter">
        </div>
        <div class="sidebar-body" id="sidebarBody"></div>
    </aside>

    <div class="main">
        <div class="session-header" id="sessionHeader">
            <div class="sh-top">
                <div class="sh-title-area">
                    <div class="sh-title" id="sessionTitle" onclick="startEditTitle()" title="Click to edit name"></div>
                </div>
                <div class="sh-actions" id="sessionActions"></div>
            </div>
            <div class="sh-meta" id="sessionMeta"></div>
        </div>

        <div class="toolbar" id="toolbar" style="display:none;">
            <div class="tab-group" id="tabGroup"></div>
            <div class="toolbar-right">
                <span id="rereviewBadge" class="rereview-badge" style="display:none;">Re-review pending</span>
                <select class="version-select" id="versionSelect" onchange="switchVersion(this.value)" style="display:none;">
                    <option value="current">Current</option>
                </select>
                <span class="status-text">
                    <span class="status-dot"></span>
                    <span id="statusText">Live</span>
                </span>
            </div>
        </div>

        <div class="content" id="content">
            <div class="empty-state">
                <div class="empty-icon">&#9881;</div>
                <h2>Select a session</h2>
                <p>Choose a session from the sidebar, or create a new one to get started.</p>
            </div>
        </div>

        <div class="action-bar" id="actionBar"></div>
    </div>

    <div class="toast-container" id="toastContainer"></div>

<script>
    // ========================================
    // CONSTANTS
    // ========================================
    const CONFIG = {
        REFRESH_INTERVAL_MS: 5000,
        TOAST_DURATION_MS: 4000,
        TERMINAL_LINES: 200,
        JIRA_BASE_URL: 'https://aplaceformom.atlassian.net/browse/',
        PREVIEW_URL_TEMPLATE: 'https://grace-frontend-dev-git-{slug}.preview.findcare.dev.aplaceformom.com/',
        PREVIEW_REPO_MATCH: 'grace-frontend'
    };

    const API = {
        SESSIONS: '/api/sessions',
        CONTENT: '/api/content',
        TERMINAL: '/api/terminal',
        ARCHIVE: '/api/archive',
        DELETE: '/api/delete',
        START_CLAUDE: '/api/start-claude',
        START_ACR_CLAUDE: '/api/start-acr-claude',
        FOCUS_TERMINAL: '/api/focus-terminal',
        REFRESH_DISCUSSION: '/api/refresh-discussion',
        RENAME_SESSION: '/api/rename-session',
        SWITCH_MODE: '/api/switch-mode',
        FIX_FINDING: '/api/fix-finding',
        IMPORT_PR_COMMENTS: '/api/import-pr-comments',
        POST_PR_COMMENT: '/api/post-pr-comment',
        REFRESH_PR: '/api/refresh-pr',
        CREATE_SESSION: '/api/create-session',
        PR_INFO: '/api/pr-info',
        RUN_APP: '/api/run-app',
        COMMIT: '/api/commit'
    };

    // ========================================
    // STATE
    // ========================================
    const state = {
        sessions: [],
        currentSession: null,
        currentTab: 'review',
        currentVersion: 'current',
        lastContent: '',
        lastSessionsJson: '',
        pendingModeSwitch: null,
        refreshPRMode: 'claude',
        modalOpen: false,
        newSession: { mode: 'review', step: 1, data: {} }
    };

    function getCurrentSession() {
        return state.sessions.find(s => s.name === state.currentSession);
    }

    // ========================================
    // CORE UTILITIES
    // ========================================
    async function apiPost(endpoint, data, options) {
        const opts = options || {};
        const body = Object.assign({}, data || {});
        if (opts.includeSession !== false && state.currentSession) {
            body.session = body.session || state.currentSession;
        }
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (opts.rawResponse) return res;
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || 'Server error');
        }
        if (opts.text) return res.text();
        return res.json();
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function convertEmojis(text) {
        const emojiMap = {
            ':white_check_mark:': '✅', ':heavy_check_mark:': '✅',
            ':x:': '❌', ':warning:': '⚠️',
            ':red_circle:': '🔴', ':orange_circle:': '🟠',
            ':yellow_circle:': '🟡', ':green_circle:': '🟢',
            ':blue_circle:': '🔵', ':bulb:': '💡',
            ':memo:': '📝', ':rocket:': '🚀',
            ':bug:': '🐛', ':lock:': '🔒',
            ':zap:': '⚡', ':recycle:': '♻️',
            ':fire:': '🔥', ':star:': '⭐',
            ':thumbsup:': '👍', ':thumbsdown:': '👎',
            ':question:': '❓', ':exclamation:': '❗',
            ':pushpin:': '📍', ':chart_with_upwards_trend:': '📈',
            ':package:': '📦', ':gear:': '⚙️',
            ':wrench:': '🔧', ':hammer:': '🔨',
            ':eyes:': '👀', ':thought_balloon:': '💭',
            ':speech_balloon:': '💬', ':mag:': '🔍',
            ':link:': '🔗', ':arrow_right:': '→',
            ':arrow_left:': '←', ':heavy_minus_sign:': '➖',
            ':heavy_plus_sign:': '➕'
        };
        let result = text;
        for (const [code, emoji] of Object.entries(emojiMap)) {
            result = result.split(code).join(emoji);
        }
        return result;
    }

    // ========================================
    // UI UTILITIES
    // ========================================
    function showToast(message, type) {
        type = type || 'success';
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(function() { toast.remove(); }, CONFIG.TOAST_DURATION_MS);
    }

    function createModal(contentHtml, options) {
        const opts = options || {};
        state.modalOpen = true;
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        if (opts.id) modal.id = opts.id;
        modal.onclick = function(e) { if (e.target === modal) closeModal(); };
        const maxW = opts.maxWidth ? 'max-width:' + opts.maxWidth + ';' : '';
        modal.innerHTML = '<div class="modal-box" style="' + maxW + '">' + contentHtml + '</div>';
        document.body.appendChild(modal);
        return modal;
    }

    function closeModal() {
        const modal = document.querySelector('.modal-overlay');
        if (modal) modal.remove();
        state.modalOpen = false;
    }

    async function withButtonState(btn, options, asyncFn) {
        if (!btn) return;
        const opts = options || {};
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = opts.loading || '⏳';
        try {
            await asyncFn();
            if (opts.success) {
                btn.innerHTML = opts.success;
                if (opts.revert !== false) {
                    setTimeout(function() { btn.innerHTML = originalHtml; btn.disabled = false; }, 2000);
                }
            } else {
                btn.innerHTML = originalHtml;
                btn.disabled = false;
            }
        } catch (e) {
            btn.innerHTML = opts.error || originalHtml;
            btn.disabled = false;
            throw e;
        }
    }

    function renderEmptyState(icon, title, subtitle) {
        return '<div class="empty-state"><div class="empty-icon">' + icon + '</div><h2>' + title + '</h2><p>' + subtitle + '</p></div>';
    }

    // ========================================
    // URL BUILDERS
    // ========================================
    function buildRepoBaseUrl(session) {
        let repoUrl = session.url || '';
        if (!repoUrl && session.repository) {
            repoUrl = session.repository.includes('github.com') ? session.repository : 'https://github.com/' + session.repository;
        }
        return repoUrl.replace(/\\/pull\\/\\d+.*$/, '');
    }

    function buildPRUrl(session) {
        const base = buildRepoBaseUrl(session);
        if (session.pr && session.pr.match(/^\\d+$/) && base) {
            return base + '/pull/' + session.pr;
        }
        if (session.pr && session.pr.includes('http')) return session.pr;
        return null;
    }

    function buildPreviewUrl(session) {
        const base = buildRepoBaseUrl(session);
        if (!session.branch || !base.includes(CONFIG.PREVIEW_REPO_MATCH)) return null;
        var headBranch = session.branch
            .replace(/\\s*→\\s*.*/g, '').replace(/\\s*->\\s*.*/g, '')
            .replace(/\\s+(main|master)$/i, '').trim();
        var branchSlug = headBranch.replace(/\\//g, '-').toLowerCase();
        return CONFIG.PREVIEW_URL_TEMPLATE.replace('{slug}', branchSlug);
    }

    // ========================================
    // SESSION LOADING
    // ========================================
    async function loadSessions() {
        try {
            const res = await fetch(API.SESSIONS);
            const newSessions = await res.json();
            const newJson = JSON.stringify(newSessions);
            if (newJson !== state.lastSessionsJson) {
                state.lastSessionsJson = newJson;
                state.sessions = newSessions;
                renderSessions();
            }
        } catch (e) {
            console.error('Failed to load sessions', e);
        }
    }

    function renderSessions() {
        const filter = document.getElementById('filter').value.toLowerCase();
        const filtered = state.sessions.filter(s =>
            Object.values(s).some(v => typeof v === 'string' && v.toLowerCase().includes(filter))
        );

        // Server already sorts: live first, then by creation date, archived last.
        // Group into visual sections.
        const live = filtered.filter(s => !s.archived && s.has_terminal);
        const active = filtered.filter(s => !s.archived && !s.has_terminal && !s.stale && s.pr_state !== 'MERGED' && s.pr_state !== 'CLOSED');
        const done = filtered.filter(s => !s.archived && !s.has_terminal && (s.stale || s.pr_state === 'MERGED' || s.pr_state === 'CLOSED'));
        const archived = filtered.filter(s => s.archived);

        let html = '';

        if (live.length > 0) {
            html += '<div class="section-label">Live &middot; ' + live.length + '</div>';
            html += live.map(s => renderSessionItem(s)).join('');
        }

        if (active.length > 0) {
            html += '<div class="section-label">Active &middot; ' + active.length + '</div>';
            html += active.map(s => renderSessionItem(s)).join('');
        }

        if (done.length > 0) {
            html += '<div class="section-label">Done / Stale &middot; ' + done.length + '</div>';
            html += done.map(s => renderSessionItem(s)).join('');
        }

        if (archived.length > 0) {
            html += '<div class="section-label">Archived &middot; ' + archived.length + '</div>';
            html += archived.map(s => renderSessionItem(s)).join('');
        }

        if (filtered.length === 0) {
            html = '<div style="padding:24px;text-align:center;color:var(--text-tertiary);font-size:13px;">No sessions found</div>';
        }

        document.getElementById('sidebarBody').innerHTML = html;
    }

    function renderSessionItem(s) {
        const isActive = state.currentSession === s.name;
        const title = escapeHtml(s.display_title || s.name);
        const mode = s.mode || s.session_type || '';
        const isStale = s.stale && !s.has_terminal;
        const isMerged = s.pr_state === 'MERGED';
        const isClosed = s.pr_state === 'CLOSED';
        const dimmed = isStale || isMerged || isClosed || s.archived;

        let tags = '';
        if (s.has_terminal) tags += '<span class="tag tag-terminal">Live</span>';
        if (isMerged) tags += '<span class="tag tag-merged">Merged</span>';
        if (isClosed) tags += '<span class="tag tag-closed">Closed</span>';
        if (mode) tags += '<span class="tag tag-mode">' + mode + '</span>';
        if (s.has_review) tags += '<span class="tag tag-review">Review</span>';
        if (s.has_findings) tags += '<span class="tag tag-findings">Findings</span>';
        if (s.has_devlog) tags += '<span class="tag tag-devlog">Devlog</span>';
        if (isStale && !isMerged && !isClosed) tags += '<span class="tag tag-stale">Stale</span>';
        if (s.archived) tags += '<span class="tag tag-archived">Archived</span>';

        return '<div class="session-item ' + (isActive ? 'active' : '') + (dimmed ? ' dimmed' : '') + '" onclick="selectSession(&quot;' + s.name + '&quot;)">' +
            '<div class="si-title">' + (s.has_terminal ? '<span class="live-indicator"></span>' : '') + title + '</div>' +
            '<div class="si-folder">' + s.name + '</div>' +
            '<div class="si-tags">' + tags + '</div>' +
        '</div>';
    }

    // ========================================
    // SESSION SELECTION & HEADER
    // ========================================
    async function selectSession(name) {
        state.currentSession = name;
        const session = getCurrentSession();

        let defaultTab = 'review';
        if (session) {
            if (session.session_type === 'development' && session.has_devlog) defaultTab = 'devlog';
            else if (session.has_review) defaultTab = 'review';
            else if (session.has_findings) defaultTab = 'findings';
            else if (session.has_devlog) defaultTab = 'devlog';
        }
        state.currentTab = defaultTab;

        renderSessions();
        renderSessionHeader();
        renderToolbar();
        renderActionBar();
        await loadContent();
    }

    function renderSessionHeader() {
        const session = getCurrentSession();
        const header = document.getElementById('sessionHeader');

        if (!session) {
            header.classList.remove('visible');
            document.getElementById('toolbar').style.display = 'none';
            return;
        }

        header.classList.add('visible');
        document.getElementById('toolbar').style.display = 'flex';

        document.getElementById('sessionTitle').textContent = session.display_title || session.name;

        let actions = '';
        if (session.has_terminal) {
            actions += '<button class="btn-action primary" onclick="focusTerminal()">🎯 Focus Terminal</button>';
        } else if (!session.archived) {
            actions += '<button class="btn-action primary" onclick="startClaude()">▶ Start Claude</button>';
        }
        if (session.pr && !session.archived) {
            actions += '<button class="btn-action" onclick="refreshDiscussion()" id="btnRefreshDisc">💬 Refresh Discussion</button>';
        }
        if (!session.archived) {
            actions += '<button class="btn-action warn" onclick="archiveSession()">📦 Archive</button>';
        } else {
            actions += '<button class="btn-action" disabled>📦 Archived</button>';
        }
        actions += '<button class="btn-action danger" onclick="deleteSession()">🗑 Delete</button>';
        document.getElementById('sessionActions').innerHTML = actions;

        let meta = '';
        const repoBaseUrl = buildRepoBaseUrl(session);
        const prUrl = buildPRUrl(session);

        if (prUrl && session.pr && session.pr.match(/^\\d+$/)) {
            meta += '<a class="sh-link" href="' + prUrl + '" target="_blank">🔗 PR #' + session.pr + '</a>';
        } else if (prUrl) {
            meta += '<a class="sh-link" href="' + prUrl + '" target="_blank">🔗 Pull Request</a>';
        }

        if (repoBaseUrl && repoBaseUrl.includes('http')) {
            meta += '<a class="sh-link" href="' + repoBaseUrl + '" target="_blank">📂 Repo</a>';
        }

        if (session.jira) {
            meta += '<a class="sh-link" href="' + CONFIG.JIRA_BASE_URL + session.jira + '" target="_blank">🎫 ' + session.jira + '</a>';
        }

        const previewUrl = buildPreviewUrl(session);
        if (previewUrl) {
            meta += '<a class="sh-link" href="' + previewUrl + '" target="_blank">🌐 Preview</a>';
        }

        const author = session.author || session.creator;
        if (author) meta += '<span class="sh-divider"></span><span class="sh-info">👤 ' + escapeHtml(author) + '</span>';
        if (session.branch) meta += '<span class="sh-info">🌿 ' + escapeHtml(session.branch) + '</span>';
        if (session.created) meta += '<span class="sh-info">📅 ' + escapeHtml(session.created) + '</span>';

        document.getElementById('sessionMeta').innerHTML = meta;
    }

    // ========================================
    // EDITABLE TITLE
    // ========================================
    function startEditTitle() {
        const session = getCurrentSession();
        if (!session) return;

        const titleEl = document.getElementById('sessionTitle');
        const currentText = session.display_title || session.name;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'sh-title-input';
        input.value = currentText;

        titleEl.replaceWith(input);
        input.focus();
        input.select();

        function finishEdit() {
            const newTitle = input.value.trim() || currentText;
            const newEl = document.createElement('div');
            newEl.className = 'sh-title';
            newEl.id = 'sessionTitle';
            newEl.onclick = startEditTitle;
            newEl.title = 'Click to edit name';
            newEl.textContent = newTitle;
            input.replaceWith(newEl);

            if (newTitle !== currentText) {
                saveSessionTitle(state.currentSession, newTitle);
            }
        }

        input.addEventListener('blur', finishEdit);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = currentText; input.blur(); }
        });
    }

    async function saveSessionTitle(sessionName, newTitle) {
        try {
            await apiPost(API.RENAME_SESSION, { session: sessionName, title: newTitle }, { includeSession: false });
            showToast('Session renamed');
            await loadSessions();
        } catch (e) {
            showToast('Rename failed: ' + e.message, 'error');
        }
    }

    // ========================================
    // TOOLBAR & TABS
    // ========================================
    function renderToolbar() {
        const session = getCurrentSession();
        if (!session) return;

        const tabs = [
            { id: 'review', label: 'Review', available: session.has_review },
            { id: 'findings', label: 'Findings', available: session.has_findings },
            { id: 'devlog', label: 'Devlog', available: session.has_devlog },
            { id: 'terminal', label: 'Terminal', available: session.has_terminal, live: true }
        ];

        let tabHtml = '';
        tabs.forEach(t => {
            if (!t.available) return;
            const activeClass = t.id === state.currentTab ? ' active' : '';
            const dot = (t.live && t.id === 'terminal') ? '<span class="tab-dot"></span>' : '';
            tabHtml += '<button class="tab' + activeClass + '" data-type="' + t.id + '" onclick="switchTab(&apos;' + t.id + '&apos;)">' + t.label + dot + '</button>';
        });

        document.getElementById('tabGroup').innerHTML = tabHtml;

        const versionSelect = document.getElementById('versionSelect');
        const versions = session.review_versions || [];
        if (versions.length > 0) {
            versionSelect.innerHTML = '<option value="current">Current</option>' +
                versions.map(v => '<option value="' + v + '">' + v.toUpperCase() + ' (archived)</option>').join('');
            versionSelect.style.display = 'inline-block';
            versionSelect.value = state.currentVersion;
        } else {
            versionSelect.style.display = 'none';
        }

        document.getElementById('rereviewBadge').style.display = session.has_rereview ? 'inline-block' : 'none';
    }

    function renderActionBar() {
        const session = getCurrentSession();
        const bar = document.getElementById('actionBar');

        if (!session || session.archived) {
            bar.classList.remove('visible');
            return;
        }

        const hasRepo = !session.archived;
        const hasPR = !!session.pr;
        const hasReview = !!session.has_review;

        let html = '<span class="ab-label">Actions</span>';

        if (hasRepo) {
            html += '<button class="btn-action" onclick="showSwitchModeModal()">🔀 Switch Mode</button>';
        }
        if (hasReview && hasRepo) {
            html += '<button class="btn-action" onclick="fixAllFindings()">🔧 Fix All Findings</button>';
        }
        if (hasPR && hasRepo) {
            html += '<span class="ab-divider"></span>';
            html += '<button class="btn-action" onclick="importPRComments()">📥 Import PR Comments</button>';
            html += '<button class="btn-action" onclick="showRefreshPRModal()">🔄 Refresh PR</button>';
        }
        if (hasRepo) {
            html += '<span class="ab-divider"></span>';
            html += '<button class="btn-action" onclick="runApplication()">▶ Run App</button>';
            html += '<button class="btn-action" onclick="commitChanges()">💾 Commit</button>';
        }

        bar.innerHTML = html;
        bar.classList.add('visible');
    }

    function switchTab(type) {
        state.currentTab = type;
        state.currentVersion = 'current';
        document.getElementById('versionSelect').value = 'current';
        renderToolbar();
        loadContent();
    }

    function switchVersion(version) {
        state.currentVersion = version;
        loadContent();
    }

    // ========================================
    // CONTENT LOADING
    // ========================================
    async function loadContent() {
        if (!state.currentSession) return;
        try {
            if (state.currentTab === 'terminal') {
                const res = await fetch(API.TERMINAL + '?session=' + encodeURIComponent(state.currentSession) + '&lines=' + CONFIG.TERMINAL_LINES);
                const text = await res.text();
                if (text !== state.lastContent) {
                    state.lastContent = text;
                    if (text.trim()) {
                        document.getElementById('content').innerHTML =
                            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
                            '<h2 style="margin:0;border:none;padding:0;font-size:15px;">Terminal Output</h2>' +
                            '<button class="btn-action primary" onclick="focusTerminal()">🎯 Focus Terminal</button>' +
                            '</div>' +
                            '<div class="terminal-output">' + escapeHtml(text) + '</div>';
                    } else {
                        document.getElementById('content').innerHTML = renderEmptyState('💻', 'No terminal output', 'Start a Claude session to see output here');
                    }
                }
                document.getElementById('statusText').textContent = 'Updated ' + new Date().toLocaleTimeString();
                return;
            }

            var url = API.CONTENT + '?session=' + encodeURIComponent(state.currentSession) + '&type=' + state.currentTab;
            if (state.currentVersion !== 'current') url += '&version=' + encodeURIComponent(state.currentVersion);
            const res = await fetch(url);
            const text = await res.text();
            if (text !== state.lastContent) {
                state.lastContent = text;
                if (text.trim()) {
                    var header = '';
                    if (state.currentVersion !== 'current') {
                        header = '<div style="background:var(--amber-bg);color:var(--amber);padding:8px 12px;border-radius:var(--radius-md);margin-bottom:12px;font-size:13px;border:1px solid rgba(240,180,41,0.2);">📦 Viewing archived version: ' + state.currentVersion.toUpperCase() + '</div>';
                    }
                    const convertedText = convertEmojis(text);
                    document.getElementById('content').innerHTML = header + marked.parse(convertedText);
                    if (state.currentTab === 'review') {
                        const findings = parseFindingsFromMarkdown(convertedText);
                        const tracker = buildFindingsTracker(convertedText, findings);
                        if (tracker) {
                            document.getElementById('content').insertAdjacentHTML('afterbegin', tracker);
                        }
                        addPRCommentButtons(convertedText);
                    }
                } else {
                    document.getElementById('content').innerHTML = renderEmptyState('📝', 'No content yet', 'Waiting for ' + state.currentTab + ' to be generated...');
                }
                document.getElementById('statusText').textContent = 'Updated ' + new Date().toLocaleTimeString();
            }
        } catch (e) {
            console.error('Failed to load content', e);
        }
    }

    document.getElementById('filter').addEventListener('input', renderSessions);

    // ========================================
    // SESSION ACTIONS
    // ========================================
    async function archiveSession() {
        if (!state.currentSession) return;
        const session = getCurrentSession();
        if (!session || session.archived) return;
        if (!confirm('Archive session "' + (session.display_title || state.currentSession) + '"?\\n\\nThis will delete the cloned repo but keep review files.')) return;

        try {
            await apiPost(API.ARCHIVE);
            showToast('Session archived');
            await loadSessions();
            renderSessionHeader();
            renderActionBar();
        } catch (e) { showToast('Archive failed: ' + e.message, 'error'); }
    }

    async function startClaude() {
        if (!state.currentSession) return;
        const session = getCurrentSession();
        if (session?.archived) { showToast('Cannot start Claude on archived session', 'error'); return; }
        try {
            const data = await apiPost(API.START_CLAUDE);
            if (data.status === 'started') {
                showToast('Claude session started in new terminal');
                setTimeout(() => loadSessions(), 1000);
            } else { showToast('Unexpected response', 'error'); }
        } catch (e) { showToast('Failed to start Claude: ' + e.message, 'error'); }
    }

    async function refreshDiscussion() {
        if (!state.currentSession) return;
        const btn = document.getElementById('btnRefreshDisc');
        try {
            await withButtonState(btn, { loading: '⏳ Refreshing...', revert: true }, async function() {
                const data = await apiPost(API.REFRESH_DISCUSSION);
                if (data.status === 'refreshed') {
                    const total = data.review_comments + data.reviews + data.issue_comments;
                    showToast('Discussion refreshed: ' + total + ' comments');
                }
            });
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
        if (btn) { btn.disabled = false; btn.innerHTML = '💬 Refresh Discussion'; }
    }

    async function focusTerminal() {
        if (!state.currentSession) return;
        try {
            const data = await apiPost(API.FOCUS_TERMINAL);
            if (!data.found) showToast('Terminal not found. Is a Claude session running?', 'error');
        } catch (e) { showToast('Focus terminal failed', 'error'); }
    }

    async function deleteSession() {
        if (!state.currentSession) return;
        const session = getCurrentSession();
        if (!confirm('DELETE session "' + (session?.display_title || state.currentSession) + '"?\\n\\nThis permanently deletes ALL files. Cannot be undone.')) return;
        try {
            await apiPost(API.DELETE);
            state.currentSession = null;
            await loadSessions();
            document.getElementById('sessionHeader').classList.remove('visible');
            document.getElementById('toolbar').style.display = 'none';
            document.getElementById('actionBar').classList.remove('visible');
            document.getElementById('content').innerHTML = renderEmptyState('⚙', 'Select a session', 'Choose a session from the sidebar, or create a new one.');
        } catch (e) { showToast('Delete failed: ' + e.message, 'error'); }
    }

    // ========================================
    // PR COMMENT SYSTEM
    // ========================================
    function parseFindingsFromMarkdown(rawMarkdown) {
        const findings = [];
        const findingRegex = /####\\s*(?:Finding\\s*#?)?([A-Za-z]*-?\\d+)[.:\\s]+([^\\n]+)\\n([\\s\\S]*?)(?=####|$)/gi;
        let match;

        while ((match = findingRegex.exec(rawMarkdown)) !== null) {
            const findingBody = match[3];
            const locMatch = findingBody.match(/(?:📍\\s*\\*\\*Location:\\*\\*|\\*\\*File:\\*\\*)\\s*`([^`]+)`/);
            if (!locMatch) continue;
            const location = locMatch[1];
            const fileLineMatch = location.match(/^([^:]+):(\\d+)(?:-(\\d+))?/);
            if (!fileLineMatch) continue;

            const problemMatch = findingBody.match(/\\*\\*Problem:?\\*\\*\\s*([^*]+?)(?=\\*\\*|$)/s) || findingBody.match(/Problem:\\s*([^\\n]+)/i);
            const problem = problemMatch ? problemMatch[1].trim().replace(/\\n+/g, ' ') : '';
            const impactMatch = findingBody.match(/\\*\\*Impact:?\\*\\*\\s*([^*]+?)(?=\\*\\*|$)/s) || findingBody.match(/\\*\\*Why[^:]*:\\*\\*\\s*([^*]+?)(?=\\*\\*|$)/s) || findingBody.match(/Impact:\\s*([^\\n]+)/i);
            const impact = impactMatch ? impactMatch[1].trim().replace(/\\n+/g, ' ') : '';
            const suggestedMatch = findingBody.match(/\\*\\*Suggest[^:]*:?\\*\\*\\s*([^`*]+?)(?=```|\\*\\*|$)/s) || findingBody.match(/\\*\\*(?:Fix|Recommendation):?\\*\\*\\s*([^`*]+?)(?=```|\\*\\*|$)/s);
            const suggested = suggestedMatch ? suggestedMatch[1].trim().replace(/\\n+/g, ' ') : '';
            const codeMatch = findingBody.match(/\\*\\*Suggest[^*]*\\*\\*[\\s\\S]*?```(?:suggestion|[a-z]*)\\n([\\s\\S]*?)```/);
            const suggestedCode = codeMatch ? codeMatch[1].trim() : '';

            findings.push({
                number: match[1], title: match[2].trim(),
                file: fileLineMatch[1], line: parseInt(fileLineMatch[2]),
                endLine: fileLineMatch[3] ? parseInt(fileLineMatch[3]) : null,
                problem: problem, impact: impact,
                suggested: suggested, suggestedCode: suggestedCode
            });
        }

        const simpleRegex = /####\\s*(?:Finding\\s*#?\\d+[:\\s]*)?([\\s\\S]*?)\\n[\\s\\S]*?(?:📍|\\*\\*Location:\\*\\*)\\s*`?([^`\\n]+\\.[a-z]+:\\d+[^`\\n]*)`?/gi;
        while ((match = simpleRegex.exec(rawMarkdown)) !== null) {
            const location = match[2].trim();
            const locMatch = location.match(/^([^:]+):(\\d+)(?:-(\\d+))?/);
            if (locMatch && !findings.some(f => f.file === locMatch[1] && f.line === parseInt(locMatch[2]))) {
                findings.push({ title: match[1].trim(), file: locMatch[1], line: parseInt(locMatch[2]), endLine: locMatch[3] ? parseInt(locMatch[3]) : null, problem: match[1].trim() });
            }
        }

        return findings;
    }

    function createFindingActionButtons(finding) {
        const btnContainer = document.createElement('span');
        btnContainer.className = 'finding-actions';

        const btn = document.createElement('button');
        btn.className = 'btn-inline';
        btn.innerHTML = '💬 Post to PR';
        btn.dataset.file = finding.file;
        btn.dataset.line = finding.line;
        btn.dataset.finding = JSON.stringify(finding);
        btn.onclick = function() { postToPR(this); };

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn-inline';
        copyBtn.innerHTML = '🔗 Open';
        copyBtn.title = 'Copy comment & open PR at ' + finding.file + ':' + finding.line;
        copyBtn.onclick = function() {
            withButtonState(copyBtn, { loading: '⏳', revert: true }, function() {
                return copyAndOpenPR(finding);
            }).catch(function() {});
        };

        const fixBtn = document.createElement('button');
        fixBtn.className = 'btn-inline';
        fixBtn.innerHTML = '🔧 Fix';
        fixBtn.onclick = async function() {
            try {
                await withButtonState(fixBtn, { loading: '⏳', success: '✅', revert: false }, async function() {
                    await apiPost(API.FIX_FINDING, { finding: finding, fix_all: false });
                    showToast('Claude launched to fix finding #' + finding.number);
                });
            } catch (e) {
                showToast('Failed: ' + e.message, 'error');
                fixBtn.innerHTML = '🔧 Fix';
                fixBtn.disabled = false;
            }
        };

        btnContainer.appendChild(btn);
        btnContainer.appendChild(copyBtn);
        btnContainer.appendChild(fixBtn);
        return btnContainer;
    }

    function buildFindingsTracker(rawMarkdown, findings) {
        if (!findings || findings.length === 0) return '';

        function getSeverity(f, rawMarkdown) {
            const num = f.number || '';
            if (num.startsWith('C') || num.startsWith('c')) return { label: 'Critical', cls: 'sev-critical' };
            if (num.startsWith('I') || num.startsWith('i')) return { label: 'Important', cls: 'sev-important' };
            if (num.startsWith('M') || num.startsWith('m')) return { label: 'Minor', cls: 'sev-minor' };
            const idx = rawMarkdown.indexOf('#### ' + (num.match(/^\\d+$/) ? 'Finding #' + num : num));
            if (idx > -1) {
                const before = rawMarkdown.substring(Math.max(0, idx - 200), idx);
                if (/###\\s*Critical/i.test(before)) return { label: 'Critical', cls: 'sev-critical' };
                if (/###\\s*Important/i.test(before)) return { label: 'Important', cls: 'sev-important' };
                if (/###\\s*Minor/i.test(before)) return { label: 'Minor', cls: 'sev-minor' };
            }
            return { label: 'Info', cls: 'sev-info' };
        }

        let html = '<div class="findings-tracker">';
        html += '<div class="ft-header"><span class="ft-title">📋 Findings Tracker</span>';
        html += '<span class="ft-count">' + findings.length + ' finding' + (findings.length > 1 ? 's' : '') + '</span></div>';
        html += '<table class="ft-table"><thead><tr>';
        html += '<th>#</th><th>Severity</th><th>Title</th><th>Location</th>';
        html += '</tr></thead><tbody>';

        findings.forEach(function(f) {
            const sev = getSeverity(f, rawMarkdown);
            const anchor = 'finding-' + (f.number || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
            html += '<tr>';
            html += '<td><strong>' + escapeHtml(f.number || '?') + '</strong></td>';
            html += '<td><span class="sev-badge ' + sev.cls + '">' + sev.label + '</span></td>';
            html += '<td><a href="#' + anchor + '" class="ft-link">' + escapeHtml(f.title || 'Untitled') + '</a></td>';
            html += '<td class="ft-loc">' + escapeHtml(f.file + ':' + f.line) + '</td>';
            html += '</tr>';
        });

        html += '</tbody></table></div>';
        return html;
    }

    function addPRCommentButtons(rawMarkdown) {
        const session = getCurrentSession();
        if (!session || !session.pr || session.archived) return;

        const content = document.getElementById('content');
        const h4s = content.querySelectorAll('h4');
        const findings = parseFindingsFromMarkdown(rawMarkdown);

        h4s.forEach(function(h4) {
            const text = h4.textContent || '';
            const finding = findings.find(f =>
                text.includes(f.title?.substring(0, 30)) ||
                (f.number && text.includes('#' + f.number)) ||
                (f.number && text.match(new RegExp('\\\\b' + f.number.replace('-', '[\\\\-.]') + '[.\\\\s]')))
            );
            if (finding) {
                const anchor = 'finding-' + (finding.number || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
                h4.id = anchor;
                h4.appendChild(createFindingActionButtons(finding));
            }
        });
    }

    function formatFindingComment(finding) {
        let comment = '**' + finding.title + '**\\n\\n';
        if (finding.problem) comment += '**Problem:** ' + finding.problem + '\\n\\n';
        if (finding.impact) comment += '**Impact:** ' + finding.impact + '\\n\\n';
        if (finding.suggested) {
            comment += '**Suggested Fix:** ' + finding.suggested;
            if (finding.suggestedCode) comment += '\\n```suggestion\\n' + finding.suggestedCode + '\\n```';
            comment += '\\n';
        } else if (finding.suggestedCode) {
            comment += '**Suggested Fix:**\\n```suggestion\\n' + finding.suggestedCode + '\\n```\\n';
        }
        return comment.trim();
    }

    async function postToPR(btn) {
        const file = btn.dataset.file;
        const line = parseInt(btn.dataset.line);
        const finding = JSON.parse(btn.dataset.finding);
        const comment = formatFindingComment(finding);

        btn.disabled = true;
        btn.innerHTML = '⏳ Posting...';

        try {
            const data = await apiPost(API.POST_PR_COMMENT, { file: file, line: line, comment: comment });
            if (data.status === 'posted') {
                btn.innerHTML = '✅ Posted';
                btn.className = 'btn-inline posted';
                showToast('Comment posted to PR #' + data.pr + ' on ' + file + ':' + line);
                if (data.comment_url) {
                    btn.onclick = function() { window.open(data.comment_url, '_blank'); };
                    btn.innerHTML = '✅ View';
                }
            } else throw new Error(data.error || 'Failed');
        } catch (e) {
            btn.innerHTML = '❌ Failed';
            btn.className = 'btn-inline error';
            btn.disabled = false;
            showToast('Failed to post: ' + e.message, 'error');
            setTimeout(function() { btn.innerHTML = '💬 Post to PR'; btn.className = 'btn-inline'; }, 3000);
        }
    }

    async function copyAndOpenPR(finding) {
        const session = getCurrentSession();
        if (!session) return;
        const comment = formatFindingComment(finding);
        navigator.clipboard.writeText(comment).then(function() {
            showToast('Comment copied! Opening PR...');
        }).catch(function() { showToast('Could not copy', 'error'); });

        let prUrl = session.url || '';
        if (!prUrl && session.repository) {
            prUrl = session.repository.includes('github.com') ? session.repository : 'https://github.com/' + session.repository;
            if (!prUrl.includes('/pull/')) prUrl += '/pull/' + session.pr;
        }
        if (prUrl) {
            const hash = await computeGitHubDiffHash(finding.file);
            const anchor = hash ? '#diff-' + hash + 'R' + finding.line : '';
            window.open(prUrl + '/files' + anchor, '_blank');
        }
    }

    async function computeGitHubDiffHash(filePath) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(filePath);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) { return null; }
    }

    // ========================================
    // MODE SWITCH
    // ========================================
    function showSwitchModeModal() {
        const session = getCurrentSession();
        if (!session) { showToast('Select a session first', 'error'); return; }
        const currentMode = session.mode || session.session_type || 'unknown';
        const detectedJira = session.jira || extractJiraFromBranch(session.branch);

        createModal(
            '<h3>Switch Mode</h3>' +
            '<p class="modal-desc">Current mode: <strong>' + currentMode + '</strong></p>' +
            '<div class="mode-options">' +
            '<button class="mode-btn ' + (currentMode === 'review' ? 'active' : '') + '" onclick="selectSwitchMode(this, &apos;review&apos;)" ' + (currentMode === 'review' ? 'disabled' : '') + '>📝 Review</button>' +
            '<button class="mode-btn ' + (currentMode === 'development' ? 'active' : '') + '" onclick="selectSwitchMode(this, &apos;development&apos;)" ' + (currentMode === 'development' ? 'disabled' : '') + '>🛠 Development</button>' +
            '<button class="mode-btn ' + (currentMode === 'investigation' ? 'active' : '') + '" onclick="selectSwitchMode(this, &apos;investigation&apos;)" ' + (currentMode === 'investigation' ? 'disabled' : '') + '>🔍 Investigation</button>' +
            '</div>' +
            '<div id="modeExtraFields">' + (detectedJira ? '<p style="color:var(--text-tertiary);font-size:12px;">Detected Jira: <strong>' + detectedJira + '</strong></p>' : '') + '</div>' +
            '<div class="modal-footer">' +
            '<button class="modal-btn" onclick="closeModal()">Cancel</button>' +
            '<button class="modal-btn primary" id="confirmModeSwitch" onclick="confirmSwitchMode()" disabled>Switch</button>' +
            '</div>'
        );
        state.pendingModeSwitch = null;
    }

    function selectSwitchMode(btn, mode) {
        state.pendingModeSwitch = mode;
        document.querySelectorAll('.mode-options .mode-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        document.getElementById('confirmModeSwitch').disabled = false;

        const fields = document.getElementById('modeExtraFields');
        if (mode === 'review') {
            fields.innerHTML = '<label>PR URL (optional):</label><input type="text" id="modePrUrl" placeholder="https://github.com/org/repo/pull/123">';
        } else if (mode === 'development') {
            const session = getCurrentSession();
            const detected = session?.jira || extractJiraFromBranch(session?.branch);
            fields.innerHTML = '<label>Jira Ticket:</label><input type="text" id="modeJira" value="' + (detected || '') + '" placeholder="PROJ-123">';
        } else if (mode === 'investigation') {
            fields.innerHTML = '<label>Focus Area (optional):</label><input type="text" id="modeFocus" placeholder="What are you investigating?">';
        }
    }

    function extractJiraFromBranch(branch) {
        if (!branch) return null;
        const match = branch.match(/([A-Z]{2,}-\\d+)/i);
        return match ? match[1].toUpperCase() : null;
    }

    async function confirmSwitchMode() {
        if (!state.pendingModeSwitch || !state.currentSession) return;
        const extraData = {};
        if (state.pendingModeSwitch === 'review') { const v = document.getElementById('modePrUrl')?.value; if (v) extraData.pr_url = v; }
        else if (state.pendingModeSwitch === 'development') { const v = document.getElementById('modeJira')?.value; if (v) extraData.jira = v; }
        else if (state.pendingModeSwitch === 'investigation') { const v = document.getElementById('modeFocus')?.value; if (v) extraData.focus = v; }

        try {
            await apiPost(API.SWITCH_MODE, { mode: state.pendingModeSwitch, extra: extraData });
            showToast('Switched to ' + state.pendingModeSwitch + ' mode');
            closeModal();
            await loadSessions();
            renderSessionHeader();
            renderActionBar();
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    // ========================================
    // FIX & IMPORT
    // ========================================
    async function fixAllFindings() {
        if (!state.currentSession) return;
        if (!confirm('Launch Claude to fix ALL open findings?')) return;
        try {
            await apiPost(API.FIX_FINDING, { fix_all: true });
            showToast('Claude launched to fix all findings');
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    async function importPRComments() {
        if (!state.currentSession) return;
        try {
            const data = await apiPost(API.IMPORT_PR_COMMENTS);
            showToast('Imported ' + data.new_findings + ' findings from ' + data.total_comments + ' comments');
            loadContent();
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    // ========================================
    // REFRESH PR
    // ========================================
    function showRefreshPRModal() {
        state.refreshPRMode = 'claude';
        createModal(
            '<h3>Refresh PR & Re-review</h3>' +
            '<p class="modal-desc">Fetch latest commits and start a new review.</p>' +
            '<div class="mode-options">' +
            '<button class="mode-btn selected" onclick="selectRefreshMode(this, &apos;claude&apos;)">🤖 Claude Only</button>' +
            '<button class="mode-btn" onclick="selectRefreshMode(this, &apos;acr+claude&apos;)">🔀 ACR + Claude</button>' +
            '</div>' +
            '<div class="modal-footer">' +
            '<button class="modal-btn" onclick="closeModal()">Cancel</button>' +
            '<button class="modal-btn primary" onclick="executeRefreshPR()">Start Re-review</button>' +
            '</div>'
        );
    }

    function selectRefreshMode(btn, mode) {
        state.refreshPRMode = mode;
        document.querySelectorAll('.mode-options .mode-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
    }

    async function executeRefreshPR(force) {
        const btn = document.querySelector('.modal-btn.primary');
        if (btn) { btn.disabled = true; btn.textContent = 'Fetching PR updates...'; }
        try {
            const payload = { mode: state.refreshPRMode };
            if (force) payload.force = true;
            const data = await apiPost(API.REFRESH_PR, payload);
            if (data.status === 'up_to_date') {
                // Show message in the modal instead of just a toast
                const modal = document.querySelector('.modal-content');
                if (modal) {
                    modal.innerHTML =
                        '<h3>PR is up to date</h3>' +
                        '<p class="modal-desc">No new commits found since last refresh.</p>' +
                        '<div class="modal-footer">' +
                        '<button class="modal-btn" onclick="closeModal()">Close</button>' +
                        '<button class="modal-btn primary" onclick="executeRefreshPR(true)">Force Re-review Anyway</button>' +
                        '</div>';
                }
            } else if (data.osascript_error) {
                showToast('Terminal error: ' + data.osascript_error, 'error');
                closeModal();
            } else {
                const msg = 'Re-review started — ' + (data.commits || '?') + ' new commit(s), v' + (data.version || '?');
                showToast(msg);
                closeModal();
            }
        } catch (e) { showToast('Failed: ' + e.message, 'error'); closeModal(); }
    }

    // ========================================
    // NEW SESSION WIZARD
    // ========================================
    function showNewSessionModal() {
        state.newSession = { mode: 'review', step: 1, data: {} };
        createModal('<div id="newSessionWizard"></div>', { id: 'newSessionModal', maxWidth: '500px' });
        renderNewSessionStep();
    }

    function renderNewSessionStep() {
        const wizard = document.getElementById('newSessionWizard');
        if (!wizard) return;
        const step = state.newSession.step;

        if (step === 1) renderWizardStep1(wizard);
        else if (step === 2) renderWizardStep2(wizard);
        else if (step === 3) renderWizardStep3(wizard);
        else if (step === 4) renderWizardStep4(wizard);
    }

    function renderWizardStep1(wizard) {
        wizard.innerHTML =
            '<h3>New Session</h3>' +
            '<p class="modal-desc">Create a new review, investigation, or development session.</p>' +
            '<div class="mode-options">' +
            '<button class="mode-btn ' + (state.newSession.mode === 'review' ? 'selected' : '') + '" onclick="selectNewSessionMode(&apos;review&apos;)">📝 Review</button>' +
            '<button class="mode-btn ' + (state.newSession.mode === 'investigation' ? 'selected' : '') + '" onclick="selectNewSessionMode(&apos;investigation&apos;)">🔍 Investigate</button>' +
            '<button class="mode-btn ' + (state.newSession.mode === 'development' ? 'selected' : '') + '" onclick="selectNewSessionMode(&apos;development&apos;)">🛠 Develop</button>' +
            '</div>' +
            '<div id="newSessionFields">' + getStep1Fields() + '</div>' +
            '<div class="modal-footer">' +
            '<button class="modal-btn" onclick="closeModal()">Cancel</button>' +
            '<button class="modal-btn primary" onclick="newSessionNext()">Next →</button>' +
            '</div>';
    }

    function renderWizardStep2(wizard) {
        const prInfo = state.newSession.data.prInfo || {};
        const detectedJira = prInfo.detected_jira || '';
        wizard.innerHTML =
            '<h3>PR Review Setup</h3>' +
            '<p class="modal-desc">Confirm the PR details and Jira ticket.</p>' +
            '<div class="pr-info-card">' +
            '<div class="pr-title">PR #' + (prInfo.pr_number || '?') + ': ' + (prInfo.title || 'Loading...') + '</div>' +
            '<div class="pr-meta">🌿 ' + (prInfo.branch || '?') + ' → ' + (prInfo.base || '?') + '<br>👤 @' + (prInfo.author || '?') + '</div>' +
            '</div>' +
            '<label>Jira Ticket:</label>' +
            (detectedJira ?
                '<div class="jira-detected">✓ Detected: <strong>' + detectedJira + '</strong></div>' +
                '<div class="mode-options">' +
                '<button class="mode-btn selected" onclick="selectJiraOption(this, &apos;detected&apos;)">Use ' + detectedJira + '</button>' +
                '<button class="mode-btn" onclick="selectJiraOption(this, &apos;other&apos;)">Enter Different</button>' +
                '<button class="mode-btn" onclick="selectJiraOption(this, &apos;none&apos;)">No Jira</button>' +
                '</div>' +
                '<input type="text" id="newSessionJira" value="' + detectedJira + '" style="display:none;" placeholder="PROJ-123">'
            :
                '<div style="color:var(--text-tertiary);font-size:12px;margin-bottom:6px;">No Jira detected from branch</div>' +
                '<input type="text" id="newSessionJira" placeholder="PROJ-123 (optional)">'
            ) +
            '<div class="modal-footer">' +
            '<button class="modal-btn" onclick="newSessionBack()">← Back</button>' +
            '<button class="modal-btn primary" onclick="newSessionNext()">Create Session →</button>' +
            '</div>';
    }

    function renderWizardStep3(wizard) {
        wizard.innerHTML =
            '<h3>Creating Session...</h3>' +
            '<div style="text-align:center;padding:24px;">' +
            '<div style="font-size:24px;margin-bottom:12px;animation:pulse 1.5s infinite;">⏳</div>' +
            '<div id="createProgress" style="color:var(--text-tertiary);font-size:13px;">Cloning repository...</div>' +
            '</div>';
        createSessionAsync();
    }

    function renderWizardStep4(wizard) {
        wizard.innerHTML =
            '<h3>Session Ready!</h3>' +
            '<div class="success-banner">✓ Session created: ' + (state.newSession.data.sessionName || 'New session') + '</div>' +
            '<label>How would you like to review?</label>' +
            '<div class="mode-options" style="margin:12px 0;">' +
            '<button class="mode-btn" onclick="startReviewTool(&apos;acr+claude&apos;)" style="flex:1;text-align:center;">🔀 ACR + Claude<br><small style="color:var(--text-tertiary);font-size:11px;">Quick scan, then deep review</small></button>' +
            '<button class="mode-btn selected" onclick="startReviewTool(&apos;claude&apos;)" style="flex:1;text-align:center;">🤖 Claude Only<br><small style="color:var(--text-tertiary);font-size:11px;">Comprehensive review</small></button>' +
            '</div>' +
            '<div class="modal-footer"><button class="modal-btn" onclick="closeModal()">Later</button></div>';
    }

    function getStep1Fields() {
        if (state.newSession.mode === 'review') {
            return '<label>PR URL:</label><input type="text" id="newSessionUrl" placeholder="https://github.com/org/repo/pull/123" value="' + (state.newSession.data.url || '') + '">';
        } else if (state.newSession.mode === 'investigation') {
            return '<label>Repository URL:</label><input type="text" id="newSessionUrl" placeholder="https://github.com/org/repo" value="' + (state.newSession.data.url || '') + '">' +
                '<label>Focus Area (optional):</label><input type="text" id="newSessionFocus" placeholder="What are you investigating?" value="' + (state.newSession.data.focus || '') + '">';
        } else {
            return '<label>Repository URL:</label><input type="text" id="newSessionUrl" placeholder="https://github.com/org/repo" value="' + (state.newSession.data.url || '') + '">' +
                '<label>Jira Ticket (required):</label><input type="text" id="newSessionJira" placeholder="PROJ-123" value="' + (state.newSession.data.jira || '') + '">';
        }
    }

    function selectNewSessionMode(mode) {
        state.newSession.mode = mode;
        renderNewSessionStep();
    }

    function selectJiraOption(btn, option) {
        const jiraInput = document.getElementById('newSessionJira');
        document.querySelectorAll('.mode-options .mode-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        if (option === 'detected') { jiraInput.style.display = 'none'; jiraInput.value = state.newSession.data.prInfo?.detected_jira || ''; }
        else if (option === 'other') { jiraInput.style.display = 'block'; jiraInput.value = ''; jiraInput.focus(); }
        else { jiraInput.style.display = 'none'; jiraInput.value = ''; }
    }

    async function newSessionNext() {
        if (state.newSession.step === 1) {
            const url = document.getElementById('newSessionUrl')?.value;
            const focus = document.getElementById('newSessionFocus')?.value;
            const jira = document.getElementById('newSessionJira')?.value;
            if (!url) { showToast('URL is required', 'error'); return; }
            state.newSession.data.url = url;
            state.newSession.data.focus = focus;
            state.newSession.data.jira = jira;

            if (state.newSession.mode === 'review' && url.includes('/pull/')) {
                // Extract defaults from URL in case API fails
                const urlMatch = url.match(/github\\.com\\/([^/]+\\/[^/]+)\\/pull\\/(\\d+)/);
                const defaultPrInfo = {
                    pr_number: urlMatch ? urlMatch[2] : '?',
                    title: 'PR #' + (urlMatch ? urlMatch[2] : '?'),
                    branch: '?', base: '?', author: '?',
                    detected_jira: null
                };
                try {
                    const res = await apiPost(API.PR_INFO, { url: url }, { includeSession: false });
                    state.newSession.data.prInfo = res;
                } catch (e) {
                    console.error('Failed to fetch PR info', e);
                    state.newSession.data.prInfo = defaultPrInfo;
                    showToast('Could not fetch PR details, using defaults', 'error');
                }
                state.newSession.step = 2;
            } else if (state.newSession.mode === 'development' && !jira) {
                showToast('Jira ticket is required for development mode', 'error');
                return;
            } else {
                state.newSession.step = 3;
            }
            renderNewSessionStep();
        } else if (state.newSession.step === 2) {
            state.newSession.data.jira = document.getElementById('newSessionJira')?.value;
            state.newSession.step = 3;
            renderNewSessionStep();
        }
    }

    function newSessionBack() {
        if (state.newSession.step > 1) { state.newSession.step--; renderNewSessionStep(); }
    }

    async function createSessionAsync() {
        const progress = document.getElementById('createProgress');
        try {
            progress.textContent = 'Creating session...';
            const data = await apiPost(API.CREATE_SESSION, {
                mode: state.newSession.mode,
                url: state.newSession.data.url,
                jira: state.newSession.data.jira,
                focus: state.newSession.data.focus
            }, { includeSession: false });
            state.newSession.data.sessionName = data.session;
            progress.textContent = 'Loading sessions...';
            await loadSessions();
            state.currentSession = data.session;
            renderSessions();
            renderSessionHeader();
            renderToolbar();
            renderActionBar();

            if (state.newSession.mode === 'review') { state.newSession.step = 4; renderNewSessionStep(); }
            else { closeModal(); showToast('Session created: ' + data.session); }
        } catch (e) {
            showToast('Failed: ' + e.message, 'error');
            state.newSession.step = 1;
            renderNewSessionStep();
        }
    }

    async function startReviewTool(tool) {
        closeModal();
        const sessionName = state.newSession.data.sessionName || state.currentSession;
        if (!sessionName) { showToast('No session to start', 'error'); return; }
        try {
            const reviewPrompt = 'Perform a comprehensive code review following CLAUDE.md. First understand the scope and WHY these changes exist. Then analyze every change through all lenses: correctness, security, complexity, clarity, DRY, and whether this is a proper fix or a hack. Write a thorough REVIEW.md with detailed findings including what is happening, the problem, impact, and suggested fixes.';
            const endpoint = tool === 'acr+claude' ? API.START_ACR_CLAUDE : API.START_CLAUDE;
            if (tool === 'acr+claude') showToast('Running ACR review, then starting Claude...', 'info');
            const payload = { session: sessionName };
            if (tool !== 'acr+claude') payload.prompt = reviewPrompt;
            const data = await apiPost(endpoint, payload, { includeSession: false });
            showToast((tool === 'acr+claude' ? 'ACR completed! Claude' : 'Claude') + ' review started');
            setTimeout(function() { loadSessions(); }, 1000);
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    // ========================================
    // RUN APP & COMMIT
    // ========================================
    async function runApplication() {
        if (!state.currentSession) return;
        try {
            const res = await apiPost(API.RUN_APP, {}, { rawResponse: true });
            const data = await res.json();
            if (data.status === 'started') {
                showToast('App started: ' + data.command);
            } else if (data.status === 'already_running') {
                if (confirm('App already running in "' + data.other_session + '". Switch?')) selectSession(data.other_session);
            } else if (data.status === 'needs_config') {
                createModal(
                    '<h3>Run App — Configuration Needed</h3>' +
                    '<p class="modal-desc">No run command is configured for this project.</p>' +
                    '<p style="font-size:13px;">Add a <code>run_command</code> to your project in:</p>' +
                    '<pre style="background:var(--bg-secondary);padding:12px;border-radius:var(--radius-md);font-size:12px;overflow-x:auto;">~/.sandbox/projects.json</pre>' +
                    '<p style="font-size:12px;color:var(--text-tertiary);">Example: <code>"run_command": "pnpm dev"</code></p>' +
                    '<div class="modal-footer">' +
                    '<button class="modal-btn" onclick="closeModal()">Close</button>' +
                    '<button class="modal-btn primary" onclick="closeModal(); runApplication();">Retry</button>' +
                    '</div>'
                );
            }
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    async function commitChanges() {
        if (!state.currentSession) return;
        try {
            const preview = await apiPost(API.COMMIT);
            if (preview.status === 'no_changes') { showToast('No changes to commit'); return; }

            createModal(
                '<h3>💾 Commit Changes</h3>' +
                '<p class="modal-desc">Review changes and enter a commit message.</p>' +
                '<pre style="background:var(--bg-secondary);padding:12px;border-radius:var(--radius-md);font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap;">' + escapeHtml(preview.diff_stat || 'No diff info') + '</pre>' +
                '<label>Commit message:</label>' +
                '<input type="text" id="commitMessage" placeholder="Describe your changes..." style="width:100%;">' +
                '<div class="modal-footer">' +
                '<button class="modal-btn" onclick="closeModal()">Cancel</button>' +
                '<button class="modal-btn primary" onclick="executeCommit()">Commit</button>' +
                '</div>'
            );
            setTimeout(function() { var el = document.getElementById('commitMessage'); if (el) el.focus(); }, 100);
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    async function executeCommit() {
        const message = document.getElementById('commitMessage')?.value;
        if (!message) { showToast('Commit message is required', 'error'); return; }
        try {
            const result = await apiPost(API.COMMIT, { message: message });
            if (result.status === 'committed') {
                showToast('Changes committed');
                closeModal();
            } else throw new Error(result.message || 'Commit failed');
        } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    }

    // ========================================
    // INIT & AUTO-REFRESH
    // ========================================
    loadSessions();
    setInterval(function() {
        if (state.modalOpen) return;
        loadSessions();
        if (state.currentSession) loadContent();
    }, CONFIG.REFRESH_INTERVAL_MS);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeModal();
        if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); showNewSessionModal(); }
    });
</script>
</body>
</html>'''
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(html.encode())

    def log_message(self, format, *args):
        pass  # Suppress logging

if __name__ == '__main__':
    import sys
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("127.0.0.1", PORT), DashboardHandler) as httpd:
            print(f"Dashboard server running on http://127.0.0.1:{PORT}", flush=True)
            httpd.serve_forever()
    except OSError as e:
        if e.errno == 48:  # Address already in use
            print(f"Error: Port {PORT} is already in use", file=sys.stderr)
            sys.exit(1)
        raise
    except KeyboardInterrupt:
        print("Server stopped")
        sys.exit(0)
