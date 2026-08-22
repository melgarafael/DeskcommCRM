```markdown
# SonghaiCRM Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the SonghaiCRM TypeScript codebase. It covers file organization, code style, commit message standards, and testing patterns, providing practical examples and command suggestions to streamline your workflow.

## Coding Conventions

### File Naming
- Use **snake_case** for all file names.
  - Example:  
    ```
    user_profile.ts
    customer_data_manager.ts
    ```

### Import Style
- Use **relative imports** for referencing modules.
  - Example:
    ```typescript
    import { getUser } from './user_utils';
    import { Customer } from '../models/customer';
    ```

### Export Style
- Use **named exports** for all modules.
  - Example:
    ```typescript
    // In user_utils.ts
    export function getUser(id: string) { ... }
    export const USER_ROLE = 'admin';
    ```

### Commit Messages
- Follow **conventional commits** with the `fix` prefix for bug fixes.
  - Example:
    ```
    fix: correct customer email validation logic
    ```

## Workflows

### Bug Fix Workflow
**Trigger:** When you need to fix a bug in the codebase  
**Command:** `/fix-bug`

1. Identify the bug and create a new branch.
2. Make code changes following the coding conventions.
3. Write or update relevant tests (`*.test.*` files).
4. Commit your changes using the `fix:` prefix and a concise description.
    - Example: `fix: resolve crash on empty customer list`
5. Push your branch and open a pull request.

### Adding a New Module
**Trigger:** When you need to add a new feature or module  
**Command:** `/add-module`

1. Create new files using snake_case naming.
2. Use relative imports to connect new and existing modules.
3. Export functions and constants using named exports.
4. Write corresponding tests in `*.test.*` files.
5. Commit with an appropriate message (e.g., `feat: add customer notes module`).

## Testing Patterns

- Test files follow the `*.test.*` naming pattern.
  - Example: `user_utils.test.ts`
- The testing framework is not explicitly specified; check existing test files for structure.
- Place tests alongside or near the modules they test.
- Ensure all new features and bug fixes are covered by tests.

## Commands
| Command      | Purpose                                 |
|--------------|-----------------------------------------|
| /fix-bug     | Start the bug fix workflow              |
| /add-module  | Start the new module addition workflow  |
```
