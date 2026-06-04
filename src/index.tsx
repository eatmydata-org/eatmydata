/* @refresh reload */
import { render } from 'solid-js/web';
import { lazy } from 'solid-js';
import { Router, Route } from '@solidjs/router';
import { ColorModeProvider, ColorModeScript } from '@kobalte/core';
import './index.css';

const Landing = lazy(() => import('./routes/landing'));
const Chat = lazy(() => import('./routes/chat'));
const Result = lazy(() => import('./routes/result'));
const Sql = lazy(() => import('./routes/sql'));
const Pii = lazy(() => import('./routes/pii'));
const Qjs = lazy(() => import('./routes/qjs'));
const Settings = lazy(() => import('./routes/settings'));
const Xlsx = lazy(() => import('./routes/xlsx'));
const DataSources = lazy(() => import('./routes/data-sources'));
const Tests = lazy(() => import('./routes/tests'));
const WaSqlite = lazy(() => import('./routes/wa-sqlite'));

const root = document.getElementById('root');

render(
    () => (
        <>
            <ColorModeScript />
            <ColorModeProvider>
                <Router>
                    <Route path="/" component={Landing} />
                    <Route path="/chat/:actionId?" component={Chat} />
                    <Route path="/result/:id" component={Result} />
                    <Route path="/sql" component={Sql} />
                    <Route path="/pii" component={Pii} />
                    <Route path="/qjs" component={Qjs} />
                    <Route path="/settings" component={Settings} />
                    <Route path="/xlsx" component={Xlsx} />
                    <Route path="/data-sources" component={DataSources} />
                    <Route path="/tests" component={Tests} />
                    <Route path="/wa-sqlite" component={WaSqlite} />
                </Router>
            </ColorModeProvider>
        </>
    ),
    root!,
);
