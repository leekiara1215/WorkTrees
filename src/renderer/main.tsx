import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './theme.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('未找到应用根节点');
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
