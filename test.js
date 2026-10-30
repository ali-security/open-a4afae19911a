const childProcess = require('child_process');
const test = require('ava');
const open = require('.');
const {openApp} = open;

// Load a fresh copy of the module as if it was running on Windows.
const loadWindowsOpen = () => {
	const modulePath = require.resolve('.');
	const cachedModule = require.cache[modulePath];
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

	delete require.cache[modulePath];
	Object.defineProperty(process, 'platform', {...platformDescriptor, value: 'win32'});

	try {
		return require('.');
	} finally {
		Object.defineProperty(process, 'platform', platformDescriptor);
		require.cache[modulePath] = cachedModule;
	}
};

// Run `open` as on Windows and return the decoded command passed to `powershell -EncodedCommand`.
const getWindowsPowerShellCommand = async run => {
	const windowsOpen = loadWindowsOpen();
	const originalSpawn = childProcess.spawn;
	let spawnArguments;

	childProcess.spawn = (command, cliArguments) => {
		spawnArguments = cliArguments;
		return {
			once() {},
			unref() {}
		};
	};

	try {
		await run(windowsOpen);
	} finally {
		childProcess.spawn = originalSpawn;
	}

	const encodedCommandIndex = spawnArguments.indexOf('-EncodedCommand');
	return Buffer.from(spawnArguments[encodedCommandIndex + 1], 'base64').toString('utf16le');
};

// PowerShell treats the ASCII and the typographic single quotes as interchangeable string delimiters.
const isPowerShellSingleQuote = character => /^['\u2018-\u201B]$/.test(character);

// Tokenize the `Start` command like PowerShell does. Only single-quoted (literal) strings and the
// bare tokens `open` emits are accepted, so anything PowerShell would evaluate (`$(...)`, backticks,
// double-quoted strings, statement separators) makes it throw.
const parsePowerShellStartCommand = command => {
	const tokens = [];
	let index = 0;

	while (index < command.length) {
		const character = command[index];

		if (character === ' ') {
			index++;
		} else if (character === ',') {
			tokens.push(',');
			index++;
		} else if (isPowerShellSingleQuote(character)) {
			let value = '';
			index++;

			for (;;) {
				if (index >= command.length) {
					throw new Error(`Unterminated PowerShell string in: ${command}`);
				}

				if (isPowerShellSingleQuote(command[index])) {
					if (!isPowerShellSingleQuote(command[index + 1])) {
						index++;
						break;
					}

					index++;
				}

				value += command[index];
				index++;
			}

			tokens.push({literal: value});
		} else {
			const bareToken = /^(?:Start|-Wait|-ArgumentList)(?=[ ,]|$)/.exec(command.slice(index));
			if (!bareToken) {
				throw new Error(`Unexpected PowerShell code at index ${index} in: ${command}`);
			}

			tokens.push(bareToken[0]);
			index += bareToken[0].length;
		}
	}

	return tokens;
};

test.serial('open URL with PowerShell subexpressions and backticks on Windows passes them literally', async t => {
	const target = 'https://example.com/?a=$(Start-Process calc)&b=`$(whoami)&c=${env:USERNAME}&d=$env:PATH&e=@(1)';
	const command = await getWindowsPowerShellCommand(windowsOpen => windowsOpen(target));

	t.is(command, `Start '${target}'`);
	t.deepEqual(parsePowerShellStartCommand(command), ['Start', {literal: target}]);
});

test.serial('open URL with single quotes on Windows passes them literally', async t => {
	const targets = [
		'https://example.com/\';Start-Process calc;\'',
		'https://example.com/\'\';Start-Process calc;\'\'',
		'https://example.com/\u2018;Start-Process calc;\u2019',
		'https://example.com/\u201A;Start-Process calc;\u201B',
		'https://example.com/\u2019\';Start-Process calc;$(whoami)\'\u2018'
	];

	for (const target of targets) {
		// eslint-disable-next-line no-await-in-loop
		const command = await getWindowsPowerShellCommand(windowsOpen => windowsOpen(target));
		t.deepEqual(parsePowerShellStartCommand(command), ['Start', {literal: target}]);
	}
});

test.serial('open URL with app and arguments on Windows passes them literally', async t => {
	const app = 'C:\\Program Files\\$(Start-Process calc)\\it\'s\u2019 `browser.exe';
	const target = 'https://example.com/?q=$(Start-Process calc)\';calc;\'';
	const appArguments = ['--flag=$(Start-Process calc)', '--quote=\'\u2018;calc;\u2019', '--backtick=`"'];

	const command = await getWindowsPowerShellCommand(windowsOpen => windowsOpen(target, {app: {name: app, arguments: appArguments}}));
	t.deepEqual(parsePowerShellStartCommand(command), [
		'Start',
		{literal: app},
		'-ArgumentList',
		{literal: target},
		',',
		{literal: appArguments[0]},
		',',
		{literal: appArguments[1]},
		',',
		{literal: appArguments[2]}
	]);

	const openAppCommand = await getWindowsPowerShellCommand(windowsOpen => windowsOpen.openApp(app, {arguments: appArguments}));
	t.deepEqual(parsePowerShellStartCommand(openAppCommand), [
		'Start',
		{literal: app},
		'-ArgumentList',
		{literal: appArguments[0]},
		',',
		{literal: appArguments[1]},
		',',
		{literal: appArguments[2]}
	]);
});

// Tests only checks that opening doesn't return an error
// it has no way make sure that it actually opened anything.

// These have to be manually verified.

test('open file in default app', async t => {
	await t.notThrowsAsync(open('index.js'));
});

test('wait for the app to close if wait: true', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com', {wait: true}));
});

test('encode URL if url: true', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com', {url: true}));
});

test('open URL in default app', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com'));
});

test('open URL in specified app', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com', {app: {name: open.apps.chrome}}));
});

test('open URL in specified app with arguments', async t => {
	await t.notThrowsAsync(async () => {
		const proc = await open('https://sindresorhus.com', {app: {name: open.apps.chrome, arguments: ['--incognito']}});
		t.deepEqual(proc.spawnargs, ['open', '-a', open.apps.chrome, 'https://sindresorhus.com', '--args', '--incognito']);
	});
});

test('return the child process when called', async t => {
	const childProcess = await open('index.js');
	t.true('stdout' in childProcess);
});

test('open URL with query strings', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com/?abc=123&def=456'));
});

test('open URL with a fragment', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com#projects'));
});

test('open URL with query strings and spaces', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com/?abc=123&def=456&ghi=with spaces'));
});

test('open URL with query strings and a fragment', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com/?abc=123&def=456#projects'));
});

test('open URL with query strings and pipes', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com/?abc=123&def=456&ghi=w|i|t|h'));
});

test('open URL with query strings, spaces, pipes and a fragment', async t => {
	await t.notThrowsAsync(open('https://sindresorhus.com/?abc=123&def=456&ghi=w|i|t|h spaces#projects'));
});

test('open URL with query strings and URL reserved characters', async t => {
	await t.notThrowsAsync(open('https://httpbin.org/get?amp=%26&colon=%3A&comma=%2C&commat=%40&dollar=%24&equals=%3D&plus=%2B&quest=%3F&semi=%3B&sol=%2F'));
});

test('open URL with query strings and URL reserved characters with `url` option', async t => {
	await t.notThrowsAsync(open('https://httpbin.org/get?amp=%26&colon=%3A&comma=%2C&commat=%40&dollar=%24&equals=%3D&plus=%2B&quest=%3F&semi=%3B&sol=%2F', {url: true}));
});

test('open URL with single backtick', async t => {
	await t.notThrowsAsync(open('https://httpbin.org/get?test=backtick ` here'));
});

test('open URL with double backticks', async t => {
	await t.notThrowsAsync(open('https://httpbin.org/get?test=backticks `` here'));
});

test('open Firefox without arguments', async t => {
	await t.notThrowsAsync(openApp(open.apps.firefox));
});

test('open Chrome in incognito mode', async t => {
	await t.notThrowsAsync(openApp(open.apps.chrome, {arguments: ['--incognito'], newInstance: true}));
});
