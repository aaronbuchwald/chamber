# chamber-todo

A minimal TODO CLI that stores items as standard markdown task-list syntax in `todos.md`.

## Run the demo

```sh
cd apps/todo
npm install
npm run demo
```

## CLI usage (via npx tsx)

```sh
# Add an item
npx tsx src/cli.ts add "buy milk"

# Mark done / undone  (n is 1-based index)
npx tsx src/cli.ts done 1
npx tsx src/cli.ts undone 1

# List views
npx tsx src/cli.ts list
npx tsx src/cli.ts list --incomplete
npx tsx src/cli.ts list --completed
```

## Storage format

`todos.md` is a plain markdown file — edit it by hand at any time:

```markdown
- [ ] buy milk
- [x] call dentist
- [ ] read Chamber spec
```

The CLI parses and writes back the same syntax, so the file stays human-readable.
