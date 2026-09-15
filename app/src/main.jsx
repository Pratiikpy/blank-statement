// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
// Must come before anything that reaches for Buffer or global.
import './polyfills.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

/**
 * Without this, one bad response makes a render throw and React unmounts the
 * whole root, leaving a blank page with no way back. A statement product that
 * shows a blank page is not a good look.
 */
class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('blank. statement crashed', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="wrap">
        <div className="top">
          <h1 className="brand">blank<span>. statement</span></h1>
        </div>
        <div className="card">
          <h2>Something in the page broke</h2>
          <p className="sub">
            Nothing was sent anywhere and nothing on the chain changed. Reload to carry on.
          </p>
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
          <p className="note">{String(this.state.error?.message ?? this.state.error)}</p>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <Boundary>
    <App />
  </Boundary>,
);
