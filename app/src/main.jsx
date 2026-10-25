import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    console.error('BOUNDARY', err && err.stack, info && info.componentStack);
    document.title = 'ERR: ' + (err && err.message);
  }
  render() {
    if (this.state.err) {
      return (
        <pre style={{ padding: 20, color: '#b00', whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {'渲染失败：\n' + String(this.state.err && (this.state.err.stack || this.state.err.message))}
        </pre>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>
);
