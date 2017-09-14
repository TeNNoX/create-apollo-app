import * as path from 'path';
import * as ip from 'ip';
import * as url from 'url';

import Spin from "../Spin";
import { ConfigPlugin } from "../ConfigPlugin";
import { Builder } from "../Builder";
import requireModule from '../requireModule';

const pkg = requireModule('./package.json');

const __WINDOWS__ = /^win/.test(process.platform);

const createPlugins = (builder: Builder, spin: Spin) => {
    const stack = builder.stack;
    const webpack = requireModule('webpack');
    const buildNodeEnv = spin.dev ? (stack.hasAny('test') ? 'test' : 'development') : 'production';

    let plugins = [];

    if (spin.dev) {
        plugins.push(new webpack.NamedModulesPlugin());
        if (stack.hasAny(['server', 'web'])) {
            plugins.push(new webpack.HotModuleReplacementPlugin());
            plugins.push(new webpack.NoEmitOnErrorsPlugin());
        }
    } else {
        plugins.push(new webpack.optimize.UglifyJsPlugin({ minimize: true }));
        plugins.push(new webpack.LoaderOptionsPlugin({ minimize: true }));
        plugins.push(new webpack.optimize.ModuleConcatenationPlugin());
    }

    const backendUrl = spin.options.backendUrl.replace('{ip}', spin.dev ? ip.address() : 'localhost');

    if (stack.hasAny('dll')) {
        const name = `vendor_${builder.parent.name}`;
        plugins = [
            new webpack.DefinePlugin({
                __DEV__: spin.dev, 'process.env.NODE_ENV': `"${buildNodeEnv}"`,
            }),
            new webpack.DllPlugin({
                name,
                path: path.join(spin.options.dllBuildDir, `${name}_dll.json`),
            }),
        ];
    } else {
        if (stack.hasAny('server')) {
            plugins = plugins.concat([
                new webpack.BannerPlugin({
                    banner: 'require("source-map-support").install();',
                    raw: true, entryOnly: false,
                }),
                new webpack.DefinePlugin({
                    __CLIENT__: false, __SERVER__: true, __SSR__: spin.options.ssr && !spin.test,
                    __DEV__: spin.dev, 'process.env.NODE_ENV': `"${buildNodeEnv}"`,
                    __BACKEND_URL__: `"${backendUrl}"`,
                }),
            ]);
        } else {
            plugins = plugins.concat([
                new webpack.DefinePlugin({
                    __CLIENT__: true, __SERVER__: false, __SSR__: spin.options.ssr && !spin.test,
                    __DEV__: spin.dev, 'process.env.NODE_ENV': `"${buildNodeEnv}"`,
                    __BACKEND_URL__: (
                        stack.platform !== 'web' ||
                        url.parse(backendUrl).hostname !== 'localhost'
                    ) ? `"${backendUrl}"` : false,
                }),
            ]);

            if (stack.hasAny('web')) {
                const ManifestPlugin = requireModule('webpack-manifest-plugin');
                plugins.push(new ManifestPlugin({
                    fileName: 'assets.json',
                }));
                let hasServer = false;
                for (let name in spin.builders) {
                    if (spin.builders[name].stack.hasAny('server')) {
                        hasServer = true;
                        break;
                    }
                }
                if (!hasServer) {
                    const HtmlWebpackPlugin = requireModule('html-webpack-plugin');
                    plugins.push(new HtmlWebpackPlugin({
                        template: path.resolve('html-plugin-template.ejs'),
                        inject: 'body',
                    }));
                }

                if (!spin.dev) {
                    plugins.push(new webpack.optimize.CommonsChunkPlugin({
                        name: 'vendor',
                        filename: '[name].[hash].js',
                        minChunks: function (module) {
                            return module.resource && module.resource.indexOf(path.resolve('./node_modules')) === 0;
                        },
                    }));
                }
            }
        }
    }

    return plugins;
};

const getDepsForNode = (builder, depPlatforms) => {
    let deps = [];
    for (let key of Object.keys(pkg.dependencies)) {
        const val = depPlatforms[key];
        if (!val || (val.constructor === Array && val.indexOf(builder.parent.name) >= 0) || val === builder.parent.name) {
            deps.push(key);
        }
    }
    return deps;
};

let curWebpackDevPort = 3000;
let webpackPortMap = {};

const createConfig = (builder: Builder, spin: Spin) => {
    const stack = builder.stack;

    const baseConfig: any = {
        name: builder.name,
        devtool: spin.dev ? '#cheap-module-source-map' : '#source-map',
        module: {
            rules: [],
        },
        resolve: {
            modules: [path.join(process.cwd(), 'node_modules'), 'node_modules'],
        },
        watchOptions: {
            ignored: /build/,
        },
        bail: !spin.dev,
    };

    const baseDevServerConfig = {
        hot: true,
        contentBase: '/',
        publicPath: '/',
        headers: { 'Access-Control-Allow-Origin': '*' },
        quiet: false,
        noInfo: true,
        stats: { colors: true, chunkModules: false },
    };

    const plugins = createPlugins(builder, spin);
    let config = {
        ...baseConfig,
        plugins,
    };

    if (stack.hasAny('server')) {
        config = {
            ...config,
            target: 'node',
            node: {
                __dirname: true,
                __filename: true,
            },
            externals: [requireModule('webpack-node-externals')({
                whitelist: [/(^webpack|^react-native)/]
            })],
        }
    }

    if (stack.hasAny('dll')) {
        const name = `vendor_${builder.parent.name}`;
        config = {
            ...config,
            devtool: '#cheap-module-source-map',
            entry: {
                vendor: getDepsForNode(builder, spin.depPlatforms),
            },
            output: {
                filename: `${name}.[hash]_dll.js`,
                path: path.resolve(spin.options.dllBuildDir),
                library: name,
            },
        };
    } else {
        if (stack.hasAny('server')) {
            const index = [];
            if (spin.dev) {
                if (__WINDOWS__) {
                    index.push('webpack/hot/poll?1000');
                } else {
                    index.push('webpack/hot/signal.js');
                }
            }
            index.push('./src/server/index.js');

            config = {
                ...config,
                entry: {
                    index,
                },
                output: {
                    devtoolModuleFilenameTemplate: spin.dev ? '../../[resource-path]' : undefined,
                    devtoolFallbackModuleFilenameTemplate: spin.dev ? '../../[resource-path];[hash]' : undefined,
                    filename: '[name].js',
                    sourceMapFilename: '[name].[chunkhash].js.map',
                    path: path.resolve(spin.options.backendBuildDir),
                    publicPath: '/',
                },
            };
        } else if (stack.hasAny('web')) {
            const backendUrl = spin.options.backendUrl.replace('{ip}', ip.address());
            const {protocol, host} = url.parse(backendUrl);
            const backendBaseUrl = protocol + '//' + host;
            let webpackDevPort;
            if (!builder.webpackDevPort) {
                if (!webpackPortMap[builder.name]) {
                    webpackPortMap[builder.name] = curWebpackDevPort++;
                }
                webpackDevPort = webpackPortMap[builder.name];
            } else {
                webpackDevPort = builder.webpackDevPort;
            }

            config = {
                ...config,
                entry: {
                    index: (spin.dev ? [`webpack-hot-middleware/client`] : []).concat([
                        './src/client/index.js',
                    ]),
                },
                output: {
                    filename: '[name].[hash].js',
                    path: path.resolve(path.join(spin.options.frontendBuildDir, 'web')),
                    publicPath: '/',
                },
                devServer: {
                    ...baseDevServerConfig,
                    port: webpackDevPort,
                    proxy: {
                        '!/*.hot-update.{json,js}': {
                            target: backendBaseUrl,
                            logLevel: 'info',
                        },
                    },
                },
            };
        } else if (stack.hasAny('react-native')) {
            config = {
                ...config,
                entry: {
                    index: [
                        './src/mobile/index.js',
                    ],
                },
                output: {
                    filename: `index.mobile.bundle`,
                    publicPath: '/',
                    path: path.resolve(path.join(spin.options.frontendBuildDir, builder.name)),
                },
                devServer: {
                    ...baseDevServerConfig,
                    hot: false,
                    port: stack.hasAny('android') ? 3010 : 3020,
                },
            };
        } else {
            throw new Error(`Unknown platform target: ${stack.platform}`);
        }
    }

    return config;
};

export default class WebpackPlugin implements ConfigPlugin {
    configure(builder: Builder, spin: Spin) {
        const stack = builder.stack;

        if (stack.hasAny('webpack')) {
            builder.config = builder.config || {};
            builder.config = spin.merge(builder.config, createConfig(builder, spin));
        }
    }
}