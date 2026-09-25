#!/bin/sh
# __NAME__ for this mini, written by install.sh from runtime/templates/shim.sh.
# The front door's settings run it outside the sandbox, so it takes nothing
# from its caller's environment: sh, not bash, reads no BASH_ENV, and node
# starts with only the variables below, so NODE_OPTIONS, HOME,
# LINEAR_API_KEY or DEV_TASKS_LINEAR_ENDPOINT set in front of it reach
# nothing. AGENTD_FRONT_DOOR passes on, as 1 or empty: agentd's mark on the
# front door's session, which agentctl reads to refuse what only a person may
# do. So does AGENTD_OVER_SSH, 1 in an SSH session: doctor cannot check the
# keychain logins there, and says so. node --import with tsx's loader, not
# tsx's own command, which opens an IPC socket the sandbox refuses.
exec /usr/bin/env -i \
  HOME="__HOME__" \
  USER="__USER__" \
  LOGNAME="__USER__" \
  PATH="__PATH__" \
  AGENTD_HOME="__AGENTD_HOME__" \
  AGENTD_FRONT_DOOR="${AGENTD_FRONT_DOOR:+1}" \
  AGENTD_OVER_SSH="${SSH_CONNECTION:+1}" \
  LANG="en_US.UTF-8" \
  "__NODE__" --import "__LOADER__" "__SCRIPT__" "$@"
