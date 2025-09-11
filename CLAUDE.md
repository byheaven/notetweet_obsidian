# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NoteTweet is an Obsidian plugin that enables posting to X (formerly Twitter) directly from Obsidian notes. It supports single tweets, threads, scheduled posts, and image attachments.

## Development Commands

```bash
# Development with hot reload
npm run dev

# Production build with type checking
npm run build

# Format code with Prettier
npm run format

# Check code formatting
npm run lint
```

## Architecture

### Core Plugin Structure

The plugin follows Obsidian's plugin architecture with a main entry point that extends the Plugin class:

- **Main Entry**: `src/main.ts` - Core plugin class that initializes all features and manages lifecycle
- **Twitter Integration**: `src/TwitterHandler.ts` - Manages all Twitter API v2 interactions, authentication, and media uploads
- **Settings**: `src/settings.ts` - Configuration management with secure mode support for encrypted credentials

### Modal System

The plugin uses modals for user interaction:
- `PostTweetModal` - Main tweet composition interface with thread support
- `SecureModeGetPasswordModal` - Handles password input for encrypted credentials
- `TweetsPostedModal` - Post-success interface with undo functionality
- `ScheduledTweetsModal` - Manages scheduled tweets

### Key Patterns

1. **Thread Parsing**: Files can contain threads using `THREAD START` and `THREAD END` markers
2. **Image Detection**: Uses regex pattern `!?\[\[([a-zA-Z 0-9-\.]*\.(gif|jpe?g|tiff?|png|webp|bmp))\]\]` to find embedded images
3. **Error Handling**: Centralized error module with console and GUI loggers (`src/ErrorModule/`)
4. **Secure Mode**: Encrypts Twitter API credentials using crypto-es with user-provided password

### Twitter API Integration

The TwitterHandler class manages:
- OAuth 2.0 authentication flow
- Media uploads with automatic type detection
- Thread posting with proper reply chain handling
- Rate limiting and error handling

## Build Configuration

The project uses Rollup with:
- Svelte components for UI
- TypeScript compilation
- Development mode with watch
- Production builds strip development code using `rollup-plugin-strip-code`

## Deployment

GitHub Actions automatically creates releases when tags are pushed. The workflow:
1. Builds the plugin
2. Creates main.js, manifest.json, and styles.css
3. Packages as ZIP for Obsidian community plugins

## Important Implementation Details

### Posting Methods
1. **Selected Text**: Post highlighted text directly
2. **File Threads**: Parse entire file for thread markers
3. **Modal Composition**: Interactive UI for composing tweets

### Scheduling Feature
- Requires external server deployment (Heroku setup provided in `scheduling/`)
- Stores scheduled tweets with encrypted credentials
- Manages scheduled posts via dedicated modal

### Security Considerations
- Never store plain text API credentials
- Secure mode encrypts all sensitive data
- Password verification before credential storage
- Credentials stored in Obsidian plugin settings

## Code Conventions

- TypeScript strict mode enabled
- Svelte components for UI elements
- Async/await for all asynchronous operations
- Error messages displayed via Obsidian notices
- Consistent use of TwitterHandler for all API interactions