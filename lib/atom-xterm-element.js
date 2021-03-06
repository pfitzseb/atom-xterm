/** @babel */
/*
 * Copyright 2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Copyright 2017 Andres Mejia <amejia004@gmail.com>. All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

const fs = require('fs-extra');

const elementResizeDetectorMaker = require('element-resize-detector');
import { spawn as spawnPty } from 'node-pty';
// NOTE: Once xterm.js v3 is released, this needs to be imported as
// import { Terminal } from 'xterm';
import Terminal from 'xterm';

import AtomXtermProfileMenuElement from './atom-xterm-profile-menu-element';
import { AtomXtermProfilesSingleton } from './atom-xterm-profiles';

Terminal.loadAddon('fit');

class AtomXtermElement extends HTMLElement {

    initialize(model) {
        this.profilesSingleton = AtomXtermProfilesSingleton.instance;
        this.model = model;
        this.model.element = this;
        this.topDiv = document.createElement('div');
        this.topDiv.classList.add('atom-xterm-top-div');
        this.appendChild(this.topDiv);
        this.mainDiv = document.createElement('div');
        this.mainDiv.classList.add('atom-xterm-main-div');
        this.appendChild(this.mainDiv);
        this.menuDiv = document.createElement('div');
        this.menuDiv.classList.add('atom-xterm-menu-div');
        this.mainDiv.appendChild(this.menuDiv);
        this.terminalDiv = document.createElement('div');
        this.terminalDiv.classList.add('atom-xterm-term-container');
        this.mainDiv.appendChild(this.terminalDiv);
        this.atomXtermProfileMenuElement = new AtomXtermProfileMenuElement;
        this.isInitialized = false;
        this.initializedPromise = new Promise((resolve, reject) => {
            // Always wait for the model to finish initializing before proceeding.
            this.model.initializedPromise.then((atomXtermModel) => {
                this.setAttribute('session-id', this.model.getSessionId());
                this.atomXtermProfileMenuElement.initialize(this).then(() => {
                    this.menuDiv.append(this.atomXtermProfileMenuElement);
                    this.createTerminal().then(() => {
                        // An element resize detector is used to check when this element is
                        // resized due to the pane resizing or due to the entire window
                        // resizing.
                        this.erd = elementResizeDetectorMaker({
                            strategy: "scroll"
                        });
                        this.erd.listenTo(this.mainDiv, (element) => {
                            this.refitTerminal();
                        });
                        this.currentClickedAnchor;
                        this.terminalDiv.addEventListener('mousedown', (event) => {
                            let element = event.target;
                            if (element.tagName.toLowerCase() === 'a') {
                                this.currentClickedAnchor = element;
                            } else {
                                this.currentClickedAnchor = null;
                            }
                        });
                        resolve();
                    });
                });
            }).then(() => {
                this.isInitialized = true;
            });
        });
        return this.initializedPromise;
    }

    destroy() {
        if (this.ptyProcess) {
            this.ptyProcess.kill();
        }
        if (this.terminal) {
            this.terminal.destroy();
        }
    }

    getShellCommand() {
        return this.model.profile.command;
    }

    getArgs() {
        let args = this.model.profile.args;
        if (!Array.isArray(args)) {
            throw 'Arguments set are not an array.';
        }
        return args;
    }

    getTermType() {
        return this.model.profile.name;
    }

    checkPathIsDirectory(path) {
        return new Promise((resolve, reject) => {
            if (path) {
                fs.stat(path, (err, stats) => {
                    if (stats && stats.isDirectory()) {
                        resolve(true);
                    }
                    resolve(false);
                });
            } else {
                resolve(false);
            }
        });
    }

    getCwd() {
        return new Promise((resolve, reject) => {
            let cwd = this.model.profile.cwd;
            this.checkPathIsDirectory(cwd).then((isDirectory) => {
                if (isDirectory) {
                    resolve(cwd);
                } else {
                    cwd = this.model.getPath();
                    this.checkPathIsDirectory(cwd).then((isDirectory) => {
                        if (isDirectory) {
                            resolve(cwd);
                        } else {
                            // If the cwd from the model was invalid, reset it to null.
                            this.model.cwd = null;
                            cwd = this.profilesSingleton.getBaseProfile.cwd;
                            this.checkPathIsDirectory(cwd).then((isDirectory) => {
                                if (isDirectory) {
                                    this.model.cwd = cwd;
                                    resolve(cwd);
                                }
                                resolve(null);
                            });
                        }
                    });
                }
            });
        });
    }

    getEnv() {
        let env = this.model.profile.env;
        if (!env) {
            env = Object.assign({}, process.env);
        }
        if (typeof env !== 'object' || Array.isArray(env)) {
            throw 'Environment set is not an object.';
        }
        let setEnv = this.model.profile.setEnv;
        let deleteEnv = this.model.profile.deleteEnv;
        for (let key in setEnv) {
            env[key] = setEnv[key];
        }
        for (let key of deleteEnv) {
            delete env[key];
        }
        return env;
    }

    getEncoding() {
        return this.model.profile.encoding;
    }

    leaveOpenAfterExit() {
        return this.model.profile.leaveOpenAfterExit;
    }

    createTerminal() {
        // Attach terminal emulator to this element and refit.
        this.terminal = new Terminal({
            cursorBlink: true
        });
        this.terminal.open(this.terminalDiv, false);
        this.refitTerminal();
        this.ptyProcess;
        this.ptyProcessRunning = false;
        this.terminal.on('data', (data) => {
            this.ptyProcess.write(data);
        });
        this.terminal.on('resize', (size) => {
            if (this.ptyProcessRunning) {
                this.ptyProcess.resize(size.cols, size.rows);
            }
        });
        return this.restartPtyProcess();
    }

    restartPtyProcess() {
        return new Promise((resolve, reject) => {
            this.getCwd().then((cwd) => {
                if (this.ptyProcessRunning) {
                    this.ptyProcess.removeAllListeners('exit');
                    this.ptyProcess.kill();
                }
                // Reset the terminal.
                this.atomXtermProfileMenuElement.hideProfileMenu();
                this.terminal.clear();

                // Setup pty process.
                this.ptyProcessCommand = this.getShellCommand();
                this.ptyProcessArgs = this.getArgs();
                let name = this.getTermType();
                let env = this.getEnv();
                let encoding = this.getEncoding();

                // Attach pty process to terminal.
                // NOTE: This must be done after the terminal is attached to the
                // parent element and refitted.
                this.ptyProcessOptions = {
                    'name': name,
                    'cwd': cwd,
                    'env': env,
                }
                if (encoding) {
                    // There's some issue if 'encoding=null' is passed in the options,
                    // therefore, only set it if there's an actual encoding to set.
                    this.ptyProcessOptions['encoding'] = encoding;
                }

                this.ptyProcessOptions.cols = this.terminal.cols;
                this.ptyProcessOptions.rows = this.terminal.rows;
                // TODO: Need to check if command is valid, otherwise, at least
                // on Windows, this crashes badly.
                this.ptyProcess = spawnPty(this.ptyProcessCommand, this.ptyProcessArgs, this.ptyProcessOptions);
                this.ptyProcessRunning = true;
                this.ptyProcess.on('data', (data) => {
                    let old_title = this.model.title;
                    this.model.title = this.ptyProcess.process;
                    if (old_title !== this.model.title) {
                        this.model.emitter.emit('did-change-title', this.model.title);
                    }
                    this.terminal.write(data);
                    this.model.handleNewDataArrival();
                });
                this.ptyProcess.on('exit', (code, signal) => {
                    this.ptyProcessRunning = false;
                    if (!this.leaveOpenAfterExit()) {
                        this.model.exit();
                    } else {
                        let messageDiv = document.createElement('div');
                        let restartButton = document.createElement('button');
                        restartButton.classList.add('btn');
                        restartButton.appendChild(document.createTextNode('Restart'));
                        restartButton.addEventListener('click', (event) => {
                            this.restartPtyProcess();
                        });
                        if (code === 0) {
                            restartButton.classList.add('btn-success');
                            messageDiv.classList.add('atom-xterm-notice-success');
                            messageDiv.appendChild(document.createTextNode('The terminal process has finished successfully. '));
                        } else {
                            restartButton.classList.add('btn-error');
                            messageDiv.classList.add('atom-xterm-notice-error');
                            messageDiv.appendChild(document.createTextNode('The terminal process has exited with failure code \'' + code + '\'. '));
                        }
                        messageDiv.appendChild(restartButton);
                        this.topDiv.innerHTML = '';
                        this.topDiv.appendChild(messageDiv);
                    }
                });
                this.topDiv.innerHTML = '';
                resolve();
            });
        });
    }

    refitTerminal() {
        this.terminal.fit();
    }

    focusOnTerminal() {
        this.terminal.focus();
    }

    clickOnCurrentAnchor() {
        if (this.currentClickedAnchor) {
            this.currentClickedAnchor.click();
        }
    }

    getCurrentAnchorHref() {
        if (this.currentClickedAnchor) {
            return this.currentClickedAnchor.getAttribute('href');
        }
    }

    toggleProfileMenu() {
        // The profile menu needs to be initialized before it can be toggled.
        this.atomXtermProfileMenuElement.initializedPromise.then(() => {
            this.atomXtermProfileMenuElement.toggleProfileMenu();
        });
    }

    setNewProfile(newProfile) {
        this.model.setNewProfile(newProfile);
    }
}

module.exports = document.registerElement('atom-xterm', {
  prototype: AtomXtermElement.prototype
});
