# Quick Start Guide: Gatling Agent

This guide shows you how to use the new unified Gatling agent for creating and fixing tests.

---

## Prerequisites

1. **MCP Toolkit Configured** with these tools:
   - `git_clone`
   - `git_pull`
   - `execute_gatling_simulation`
   - `get_errors`
   - `claude_code`
   - `git_commit_and_push`

2. **Claude Code Skills** in your repository:
   - `.claude/skills/generate-gatling-test/`
   - `.claude/skills/fix-gatling-test/`
   - `.claude/skills/custom-instructions/`

3. **Agent Configuration**: Point your agent platform to `gatling_agent.md`

---

## Common Usage Patterns

### Pattern 1: Create Tests from Postman Collection

**What You Say:**
```
Create Gatling tests from my Postman collection.
Repository: https://github.com/myorg/perf-tests
Branch: main
```

**What Happens:**
1. Agent collects parameters (repo, branch)
2. Agent generates unique working directory
3. Agent clones repository
4. Agent invokes `/generate-gatling-test` skill via claude_code
5. Agent commits and pushes new tests
6. Agent reports success with file locations

**Expected Response:**
```
✅ Test creation workflow completed successfully:
- Cloned repository to /opt/working_dir/f47ac10b-58cc-4372-a567-0e02b2c3d479
- Generated new tests using /generate-gatling-test skill
- Created: src/test/java/epam/tests/PostmanApiSimulation.java
- Committed and pushed to main branch

Next steps: Review the generated tests in your repository.
```

---

### Pattern 2: Fix Failing Tests

**What You Say:**
```
Fix errors in epam.tests.ApiSimulation
Repository: https://github.com/myorg/perf-tests
Branch: bugfix/api-errors
```

**What Happens:**
1. Agent collects parameters (repo, branch, simulation class)
2. Agent generates unique working directory
3. Agent clones repository
4. Agent runs the test to capture errors
5. Agent extracts errors to errors.json
6. Agent invokes `/fix-gatling-test` skill via claude_code
7. Agent reruns test to verify fixes
8. Agent commits and pushes if successful (or reports remaining errors)

**Expected Response (Success):**
```
✅ Test fixing workflow completed successfully:
- Cloned repository to /opt/working_dir/c9bf9e57-1685-4c89-bafb-ff5af830be8a
- Initial run found 3 errors (2 compilation, 1 assertion failure)
- Invoked /fix-gatling-test skill
- Fixed all 3 errors
- Verification run: 0 errors
- Committed and pushed to bugfix/api-errors

Fixed issues:
1. Missing import for JsonPath
2. Incorrect session variable reference
3. Removed invalid status code assertion

Next steps: Pull the branch and review the fixes.
```

**Expected Response (Partial Success):**
```
⚠️ Test fixing workflow completed with remaining issues:
- Fixed 2 of 3 errors
- 1 HTTP 500 error persists

Remaining error:
- POST_checkout endpoint returns 500 (may require application restart per project guidelines)

Should I commit the partial fix or would you like to investigate the 500 error first?
```

---

### Pattern 3: Create Tests with Minimal Info

**What You Say:**
```
Generate tests from my Swagger spec.
Repo: https://github.com/myorg/api-tests
```

**What Happens:**
Agent asks for missing information:

**Agent Response:**
```
I have the repository URL. I need a few more details:

1. Which branch should I use? (e.g., main, develop, feature/new-tests)
2. Where is the Swagger spec file located? (e.g., docs/swagger.json, /path/to/openapi.yaml)

Please provide these details so I can proceed.
```

**You Respond:**
```
Use branch: develop
Swagger file is in docs/api-spec.yaml
```

**Agent Continues:**
```
✅ Got it. Proceeding with:
- Repository: https://github.com/myorg/api-tests
- Branch: develop
- Swagger spec: docs/api-spec.yaml
- Working directory: /opt/working_dir/a1b2c3d4-5e6f-7g8h-9i0j-k1l2m3n4o5p6

Starting test generation workflow...
```

---

### Pattern 4: Handle Persistent Errors

**What You Say:**
```
Fix epam.tests.CheckoutSimulation
Repo: https://github.com/myorg/perf-tests
Branch: main
```

**What Happens:**
After 1st fix attempt, errors persist.

**Agent Response:**
```
⚠️ First fix attempt completed, but errors remain:

Fixed errors (2):
✅ Compilation error: Missing ChainBuilder import
✅ Assertion failure: Removed invalid jsonPath check

Remaining errors (1):
❌ HTTP 500 error on POST_completeOrder endpoint

This may indicate:
- Application needs restart (per project error handling guidelines)
- API endpoint has a server-side issue
- Test data is invalid for current application state

Options:
1. I can commit the partial fix (2 out of 3 errors resolved)
2. You can investigate the 500 error and I'll try fixing again
3. I can attempt another fix iteration (may not help with server errors)

What would you like to do?
```

**You Respond:**
```
Commit the partial fix. I'll check the server.
```

**Agent Continues:**
```
✅ Committing partial fix:
- 2 errors resolved
- 1 HTTP 500 error documented in commit message
- Pushed to main branch

Commit message:
"Fix 2 errors in CheckoutSimulation

- Added missing ChainBuilder import
- Removed invalid jsonPath assertion on cart endpoint
- Note: POST_completeOrder still returns 500 (server-side issue)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

Next steps: Investigate server logs for POST_completeOrder endpoint.
```

---

## Parameter Reference

### Always Required
- **Repository URL**: Full git clone URL
- **Branch**: Branch name to work on

### Auto-Generated (don't provide)
- **Working Directory**: Agent generates unique UUID-based path

### Required for Test Fixing Only
- **Simulation Class**: Full package path (e.g., `epam.tests.ApiSimulation`)

### Optional Context
- **Additional Instructions**: Specific files to focus on, known issues, etc.
- **Configuration Overrides**: Custom base URLs, user counts, etc.

---

## Troubleshooting

### "I need more information"

**Symptom**: Agent asks for parameters you think you provided

**Solution**: Explicitly state all required parameters:
```
Create tests
Repository: https://github.com/myorg/tests
Branch: develop
```

---

### "claude_code skill not found"

**Symptom**: Error invoking `/generate-gatling-test` or `/fix-gatling-test`

**Solution**:
1. Verify `.claude/skills/` directory exists in your repository
2. Check skill folders are present:
   - `.claude/skills/generate-gatling-test/skill.md`
   - `.claude/skills/fix-gatling-test/skill.md`
3. Ensure `skill.prompt` files exist in each skill folder

---

### "git_clone failed with authentication error"

**Symptom**: Cannot clone repository

**Solution**:
1. Verify repository URL is correct
2. Check repository is accessible with current credentials
3. For private repos, ensure SSH keys or tokens are configured in MCP toolkit

---

### "Working directory conflict"

**Symptom**: Error about existing directory

**Solution**: Agent should auto-generate unique directories. If this occurs:
1. Check agent is generating UUIDs correctly
2. Verify MCP toolkit is using provided working_dir parameter
3. Clear old working directories if disk space is an issue

---

### "Test still fails after fixing"

**Symptom**: Errors persist through multiple fix iterations

**Solution**:
1. Review specific error messages (HTTP 500 often means server issues)
2. Check if application needs restart (per project error handling guidelines)
3. Verify test data is valid for current application state
4. Consider manual investigation if agent can't resolve

---

## Best Practices

### ✅ Do

- Provide repository URL and branch clearly
- Use full package paths for simulation classes (e.g., `epam.tests.ApiSimulation`)
- Review agent-generated summaries for important details
- Approve partial fixes if remaining errors are server-side
- Pull and review generated/fixed tests after completion

### ❌ Don't

- Don't reuse working directories manually
- Don't provide default values for optional parameters
- Don't expect agent to fix server-side issues (HTTP 500 from application)
- Don't bypass skills with custom instructions (trust the skills)

---

## Advanced Usage

### Custom Instructions for Test Generation

If you need specific customizations:

```
Generate tests from Postman collection
Repository: https://github.com/myorg/tests
Branch: develop

Additional instructions:
- Focus on the "User Management" folder only
- Use the staging base URL from application.conf
- Include all request headers from the collection
```

The agent will pass this context to the `/generate-gatling-test` skill.

---

### Iterative Fixing with Context

For complex errors:

```
Fix epam.tests.PaymentSimulation
Repository: https://github.com/myorg/tests
Branch: bugfix/payment-errors

Context:
- The payment API was updated yesterday
- New field "transactionId" is now required in POST_processPayment
- See request body in src/test/resources/bodies/payment.json
```

The agent will include this context in the `/fix-gatling-test` skill invocation.

---

## Getting Help

If you encounter issues:

1. Check `.claude/skills/custom-instructions/agent-rules.md` for project-specific rules
2. Review skill documentation:
   - `.claude/skills/generate-gatling-test/skill.md`
   - `.claude/skills/fix-gatling-test/skill.md`
3. Examine recent agent responses for error details
4. Verify MCP toolkit configuration

---

## Quick Command Templates

### Create Tests
```
Create tests from [Postman collection / Swagger spec / HAR file / cURL commands]
Repository: [GIT_URL]
Branch: [BRANCH_NAME]
```

### Fix Tests
```
Fix [SIMULATION_CLASS]
Repository: [GIT_URL]
Branch: [BRANCH_NAME]
```

### Create Tests with Context
```
Generate tests from [SOURCE]
Repository: [GIT_URL]
Branch: [BRANCH_NAME]
Additional instructions: [YOUR_CUSTOM_REQUIREMENTS]
```

### Fix Tests with Context
```
Fix [SIMULATION_CLASS]
Repository: [GIT_URL]
Branch: [BRANCH_NAME]
Context: [DESCRIBE_RECENT_CHANGES_OR_KNOWN_ISSUES]
```

---

## What's Next?

After successfully creating or fixing tests:

1. **Pull the branch** to your local environment
2. **Review the changes** to ensure they meet your requirements
3. **Run tests locally** to verify they work in your environment
4. **Merge to main** if everything looks good
5. **Integrate with CI/CD** to run tests automatically

The agent handles the heavy lifting, but you maintain full control over the final code.
