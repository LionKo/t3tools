using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace T3ToolsTray
{
    internal static class NativeMethods
    {
        public const int DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1 = 19;
        public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        public const int DWMWA_BORDER_COLOR = 34;
        public const int DWMWCP_ROUND = 2;
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiFlag);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr LoadLibrary(string lpFileName);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        public static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        public static void EnableHighDpi()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        public static void ApplyTitleBarTheme(IntPtr hwnd, bool dark)
        {
            if (hwnd == IntPtr.Zero) return;
            try
            {
                int val = dark ? 1 : 0;
                if (DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref val, sizeof(int)) != 0)
                {
                    DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1, ref val, sizeof(int));
                }
            }
            catch { }
        }

        public static bool ApplyWin11PopupChrome(IntPtr hwnd, bool dark, Color borderColor)
        {
            if (hwnd == IntPtr.Zero) return false;
            ApplyTitleBarTheme(hwnd, dark);
            bool rounded = false;
            try
            {
                int corner = DWMWCP_ROUND;
                rounded = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int)) == 0;
            }
            catch { }
            try
            {
                int colorRef = borderColor.R | (borderColor.G << 8) | (borderColor.B << 16);
                DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref colorRef, sizeof(int));
            }
            catch { }
            return rounded;
        }

        public static bool IsSystemTrayDarkTheme()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", false))
                {
                    if (key != null)
                    {
                        object sysLight = key.GetValue("SystemUsesLightTheme");
                        if (sysLight != null) return Convert.ToInt32(sysLight) == 0;
                        object appLight = key.GetValue("AppsUseLightTheme");
                        if (appLight != null) return Convert.ToInt32(appLight) == 0;
                    }
                }
            }
            catch { }
            return true;
        }

        public static float GetWindowScale(IntPtr hwnd)
        {
            try
            {
                if (hwnd != IntPtr.Zero)
                {
                    uint dpi = GetDpiForWindow(hwnd);
                    if (dpi >= 96) return dpi / 96f;
                }
            }
            catch { }
            return 1f;
        }
    }

    // Minimal zero-dependency WebView2 COM bridge calling system EmbeddedBrowserWebView.dll directly
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("4E8A3389-C9D8-4BD2-B6B5-124FEE6CC14D")]
    internal interface ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
    {
        [PreserveSig]
        int Invoke(int errorCode, IntPtr createdEnvironment);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("6C4819F3-C9B7-4260-8127-C9F5BDE7F68C")]
    internal interface ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
    {
        [PreserveSig]
        int Invoke(int errorCode, IntPtr createdController);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("57213F19-00E6-49FA-8E07-898EA01ECBD2")]
    internal interface ICoreWebView2WebMessageReceivedEventHandler
    {
        [PreserveSig]
        int Invoke(IntPtr sender, IntPtr args);
    }

    internal sealed class WebView2Host : IDisposable
    {
        private static readonly Guid IID_ICoreWebView2Controller2 = new Guid("C979903E-D4CA-4228-92EB-47EE3FA96EAB");
        private static readonly Guid IID_ICoreWebView2_19 = new Guid("6921F954-79B0-437F-A997-C85811897C68");

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CreateEnvInternalFn(
            [MarshalAs(UnmanagedType.Bool)] bool checkRunning,
            int runtimeType,
            [MarshalAs(UnmanagedType.LPWStr)] string userDataFolder,
            IntPtr envOptions,
            [MarshalAs(UnmanagedType.Interface)] ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler handler);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int EnvCreateControllerFn(IntPtr env, IntPtr parentWindow, IntPtr handler);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CtrlPutIsVisibleFn(IntPtr ctrl, [MarshalAs(UnmanagedType.Bool)] bool isVisible);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CtrlPutBounds64Fn(IntPtr ctrl, ref NativeMethods.RECT bounds);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CtrlPutBounds32Fn(IntPtr ctrl, NativeMethods.RECT bounds);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CtrlPutParentWindowFn(IntPtr ctrl, IntPtr parentWindow);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CtrlNotifyPosChangedFn(IntPtr ctrl);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CtrlCloseFn(IntPtr ctrl);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CtrlGetCoreWebView2Fn(IntPtr ctrl, out IntPtr webview);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int Ctrl2PutDefaultBgFn(IntPtr ctrl2, uint colorRgba);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WvNavigateFn(IntPtr wv, [MarshalAs(UnmanagedType.LPWStr)] string uri);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WvPostWebMessageAsJsonFn(IntPtr wv, [MarshalAs(UnmanagedType.LPWStr)] string json);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WvAddWebMessageReceivedFn(IntPtr wv, IntPtr handler, out long token);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int Wv19PutMemoryTargetFn(IntPtr wv19, int level);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int ArgsTryGetStringFn(IntPtr args, out IntPtr value);

        [ComVisible(true)]
        private sealed class EnvCompletedHandler : ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
        {
            private readonly WebView2Host _owner;
            public EnvCompletedHandler(WebView2Host owner) { _owner = owner; }
            public int Invoke(int errorCode, IntPtr createdEnvironment)
            {
                _owner.OnEnvironmentCreated(errorCode, createdEnvironment);
                return 0;
            }
        }

        [ComVisible(true)]
        private sealed class CtrlCompletedHandler : ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
        {
            private readonly WebView2Host _owner;
            public CtrlCompletedHandler(WebView2Host owner) { _owner = owner; }
            public int Invoke(int errorCode, IntPtr createdController)
            {
                _owner.OnControllerCreated(errorCode, createdController);
                return 0;
            }
        }

        [ComVisible(true)]
        private sealed class WebMessageHandler : ICoreWebView2WebMessageReceivedEventHandler
        {
            private readonly WebView2Host _owner;
            public WebMessageHandler(WebView2Host owner) { _owner = owner; }
            public int Invoke(IntPtr sender, IntPtr args)
            {
                _owner.OnWebMessageReceived(args);
                return 0;
            }
        }

        private readonly Control _hostControl;
        private readonly string _userDataDir;
        private readonly Action<string> _onMessage;
        private readonly Action _onReady;
        private readonly Action<string> _onError;

        private EnvCompletedHandler _envHandler;
        private CtrlCompletedHandler _ctrlHandler;
        private WebMessageHandler _msgHandler;

        private IntPtr _dllHandle;
        private IntPtr _envPtr;
        private IntPtr _ctrlPtr;
        private IntPtr _wvPtr;
        private IntPtr _attachedParentHwnd;
        private string _pendingUrl;
        private Color _bgColor = Color.FromArgb(255, 11, 12, 15);
        private bool _visible = true;
        private bool _disposed;

        public bool IsReady { get { return _wvPtr != IntPtr.Zero && _ctrlPtr != IntPtr.Zero; } }

        public WebView2Host(Control hostControl, string userDataDir, Action<string> onMessage, Action onReady, Action<string> onError)
        {
            _hostControl = hostControl;
            _userDataDir = userDataDir;
            _onMessage = onMessage;
            _onReady = onReady;
            _onError = onError;
        }

        public void Initialize(string initialUrl, bool initiallyVisible)
        {
            _pendingUrl = initialUrl;
            _visible = initiallyVisible;

            string dllPath = FindEmbeddedBrowserWebViewDll();
            if (string.IsNullOrEmpty(dllPath))
            {
                NotifyError("未检测到 Microsoft Edge WebView2 运行时");
                return;
            }

            try
            {
                Directory.CreateDirectory(_userDataDir);
                _dllHandle = NativeMethods.LoadLibrary(dllPath);
                if (_dllHandle == IntPtr.Zero)
                {
                    NotifyError("加载 Edge WebView2 组件失败 (Win32 " + Marshal.GetLastWin32Error() + ")");
                    return;
                }
                IntPtr proc = NativeMethods.GetProcAddress(_dllHandle, "CreateWebViewEnvironmentWithOptionsInternal");
                if (proc == IntPtr.Zero)
                {
                    NotifyError("未找到 WebView2 入口函数");
                    return;
                }
                var createEnv = (CreateEnvInternalFn)Marshal.GetDelegateForFunctionPointer(proc, typeof(CreateEnvInternalFn));
                _envHandler = new EnvCompletedHandler(this);
                int hr = createEnv(true, 0, _userDataDir, IntPtr.Zero, _envHandler);
                if (hr < 0)
                {
                    NotifyError(string.Format("初始化 WebView2 环境失败 (0x{0:X8})", hr));
                }
            }
            catch (Exception ex)
            {
                NotifyError("初始化 WebView2 异常: " + ex.Message);
            }
        }

        private void OnEnvironmentCreated(int errorCode, IntPtr createdEnvironment)
        {
            if (_disposed) return;
            if (errorCode < 0 || createdEnvironment == IntPtr.Zero)
            {
                NotifyError(string.Format("创建 WebView2 环境失败 (0x{0:X8})", errorCode));
                return;
            }

            try
            {
                _envPtr = createdEnvironment;
                Marshal.AddRef(_envPtr);

                _ctrlHandler = new CtrlCompletedHandler(this);
                IntPtr ctrlHandlerPtr = Marshal.GetComInterfaceForObject(_ctrlHandler, typeof(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler));
                try
                {
                    var createCtrl = GetVtblDelegate<EnvCreateControllerFn>(_envPtr, 3);
                    int hr = createCtrl(_envPtr, _hostControl.Handle, ctrlHandlerPtr);
                    if (hr < 0)
                    {
                        NotifyError(string.Format("创建 WebView2 控制器失败 (0x{0:X8})", hr));
                    }
                }
                finally
                {
                    Marshal.Release(ctrlHandlerPtr);
                }
            }
            catch (Exception ex)
            {
                NotifyError("创建 WebView2 控制器异常: " + ex.Message);
            }
        }

        private void OnControllerCreated(int errorCode, IntPtr createdController)
        {
            if (_disposed) return;
            if (errorCode < 0 || createdController == IntPtr.Zero)
            {
                NotifyError(string.Format("初始化 WebView2 视图失败 (0x{0:X8})", errorCode));
                return;
            }

            try
            {
                _ctrlPtr = createdController;
                Marshal.AddRef(_ctrlPtr);
                _attachedParentHwnd = _hostControl.Handle;

                var getWv = GetVtblDelegate<CtrlGetCoreWebView2Fn>(_ctrlPtr, 25);
                IntPtr wvPtr;
                int hr = getWv(_ctrlPtr, out wvPtr);
                if (hr < 0 || wvPtr == IntPtr.Zero)
                {
                    NotifyError(string.Format("获取 CoreWebView2 失败 (0x{0:X8})", hr));
                    return;
                }
                _wvPtr = wvPtr;

                SetBackgroundColor(_bgColor);
                UpdateBounds();
                bool wantVisible = _visible;
                SetVisible(wantVisible);
                if (!wantVisible) SetMemoryLow(true);

                _msgHandler = new WebMessageHandler(this);
                IntPtr msgHandlerPtr = Marshal.GetComInterfaceForObject(_msgHandler, typeof(ICoreWebView2WebMessageReceivedEventHandler));
                try
                {
                    var addMsg = GetVtblDelegate<WvAddWebMessageReceivedFn>(_wvPtr, 34);
                    long token;
                    addMsg(_wvPtr, msgHandlerPtr, out token);
                }
                finally
                {
                    Marshal.Release(msgHandlerPtr);
                }

                if (!string.IsNullOrEmpty(_pendingUrl))
                {
                    Navigate(_pendingUrl);
                }
                if (_onReady != null) _onReady();
            }
            catch (Exception ex)
            {
                NotifyError("配置 WebView2 异常: " + ex.Message);
            }
        }

        private void OnWebMessageReceived(IntPtr argsPtr)
        {
            if (_disposed || argsPtr == IntPtr.Zero) return;
            try
            {
                var getSource = GetVtblDelegate<ArgsTryGetStringFn>(argsPtr, 3);
                IntPtr source;
                if (getSource(argsPtr, out source) != 0 || source == IntPtr.Zero) return;
                string sourceUrl;
                try { sourceUrl = Marshal.PtrToStringUni(source); }
                finally { Marshal.FreeCoTaskMem(source); }
                if (!IsDashboardSource(sourceUrl, _pendingUrl)) return;

                var tryGetStr = GetVtblDelegate<ArgsTryGetStringFn>(argsPtr, 5);
                IntPtr strPtr;
                int hr = tryGetStr(argsPtr, out strPtr);
                if (hr == 0 && strPtr != IntPtr.Zero)
                {
                    string msg;
                    try { msg = Marshal.PtrToStringUni(strPtr); }
                    finally { Marshal.FreeCoTaskMem(strPtr); }
                    if (!string.IsNullOrEmpty(msg) && _onMessage != null)
                    {
                        _onMessage(msg);
                    }
                }
            }
            catch { }
        }

        internal static bool IsDashboardSource(string source, string dashboard)
        {
            Uri page, expected;
            return Uri.TryCreate(source, UriKind.Absolute, out page) &&
                Uri.TryCreate(dashboard, UriKind.Absolute, out expected) &&
                page.Scheme == Uri.UriSchemeHttp && page.Host == "127.0.0.1" &&
                expected.Scheme == page.Scheme && expected.Authority == page.Authority &&
                page.UserInfo.Length == 0 && page.AbsolutePath == "/";
        }

        public void Navigate(string url)
        {
            _pendingUrl = url;
            if (_wvPtr == IntPtr.Zero || string.IsNullOrEmpty(url)) return;
            try
            {
                var nav = GetVtblDelegate<WvNavigateFn>(_wvPtr, 5);
                nav(_wvPtr, url);
            }
            catch { }
        }

        public void PostJson(string json)
        {
            if (_wvPtr == IntPtr.Zero || string.IsNullOrEmpty(json)) return;
            try
            {
                var post = GetVtblDelegate<WvPostWebMessageAsJsonFn>(_wvPtr, 32);
                post(_wvPtr, json);
            }
            catch { }
        }

        public void UpdateBounds()
        {
            if (_ctrlPtr == IntPtr.Zero || _hostControl.IsDisposed || !_hostControl.IsHandleCreated) return;
            try
            {
                IntPtr curHwnd = _hostControl.Handle;
                if (curHwnd != IntPtr.Zero && curHwnd != _attachedParentHwnd)
                {
                    var putParent = GetVtblDelegate<CtrlPutParentWindowFn>(_ctrlPtr, 22);
                    putParent(_ctrlPtr, curHwnd);
                    _attachedParentHwnd = curHwnd;
                }
                int w = _hostControl.ClientSize.Width;
                int h = _hostControl.ClientSize.Height;
                if (w <= 0 || h <= 0) return;
                var rect = new NativeMethods.RECT
                {
                    Left = 0,
                    Top = 0,
                    Right = w,
                    Bottom = h
                };
                if (IntPtr.Size == 8)
                {
                    var putBounds = GetVtblDelegate<CtrlPutBounds64Fn>(_ctrlPtr, 6);
                    putBounds(_ctrlPtr, ref rect);
                }
                else
                {
                    var putBounds = GetVtblDelegate<CtrlPutBounds32Fn>(_ctrlPtr, 6);
                    putBounds(_ctrlPtr, rect);
                }
                var notifyPos = GetVtblDelegate<CtrlNotifyPosChangedFn>(_ctrlPtr, 23);
                notifyPos(_ctrlPtr);
            }
            catch { }
        }

        public void SetVisible(bool visible)
        {
            _visible = visible;
            if (_ctrlPtr == IntPtr.Zero) return;
            try
            {
                var putVis = GetVtblDelegate<CtrlPutIsVisibleFn>(_ctrlPtr, 4);
                putVis(_ctrlPtr, visible);
            }
            catch { }
        }

        public void SetBackgroundColor(Color color)
        {
            _bgColor = color;
            if (_ctrlPtr == IntPtr.Zero) return;
            IntPtr ctrl2Ptr = IntPtr.Zero;
            try
            {
                Guid iid = IID_ICoreWebView2Controller2;
                if (Marshal.QueryInterface(_ctrlPtr, ref iid, out ctrl2Ptr) == 0 && ctrl2Ptr != IntPtr.Zero)
                {
                    uint rgba = (uint)color.A | ((uint)color.R << 8) | ((uint)color.G << 16) | ((uint)color.B << 24);
                    var putBg = GetVtblDelegate<Ctrl2PutDefaultBgFn>(ctrl2Ptr, 27);
                    putBg(ctrl2Ptr, rgba);
                }
            }
            catch { }
            finally
            {
                if (ctrl2Ptr != IntPtr.Zero) Marshal.Release(ctrl2Ptr);
            }
        }

        // Mirrors Magpie's lowWhileHidden optimization: drops hidden WebView2 working set dramatically
        public void SetMemoryLow(bool low)
        {
            if (_wvPtr == IntPtr.Zero) return;
            IntPtr wv19Ptr = IntPtr.Zero;
            try
            {
                Guid iid = IID_ICoreWebView2_19;
                if (Marshal.QueryInterface(_wvPtr, ref iid, out wv19Ptr) == 0 && wv19Ptr != IntPtr.Zero)
                {
                    var putMem = GetVtblDelegate<Wv19PutMemoryTargetFn>(wv19Ptr, 120);
                    putMem(wv19Ptr, low ? 1 : 0);
                }
            }
            catch { }
            finally
            {
                if (wv19Ptr != IntPtr.Zero) Marshal.Release(wv19Ptr);
            }
        }

        private void NotifyError(string msg)
        {
            if (_onError != null) _onError(msg);
        }

        private static T GetVtblDelegate<T>(IntPtr comPtr, int slot) where T : class
        {
            IntPtr vtbl = Marshal.ReadIntPtr(comPtr);
            IntPtr fnPtr = Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size);
            return Marshal.GetDelegateForFunctionPointer(fnPtr, typeof(T)) as T;
        }

        private static string FindEmbeddedBrowserWebViewDll()
        {
            string arch = IntPtr.Size == 8 ? "x64" : "x86";
            string rel = Path.Combine("EBWebView", arch, "EmbeddedBrowserWebView.dll");

            // 1. Check standard EdgeWebView2 Runtime install directories (newest version first)
            string[] roots = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\EdgeWebView\Application"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\EdgeWebView\Application"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\EdgeWebView\Application")
            };

            string bestPath = null;
            Version bestVer = null;

            foreach (string root in roots)
            {
                if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) continue;
                try
                {
                    foreach (string dir in Directory.GetDirectories(root))
                    {
                        string candidate = Path.Combine(dir, rel);
                        if (!File.Exists(candidate)) continue;
                        string folderName = Path.GetFileName(dir);
                        Version v;
                        if (Version.TryParse(folderName, out v))
                        {
                            if (bestVer == null || v > bestVer)
                            {
                                bestVer = v;
                                bestPath = candidate;
                            }
                        }
                        else if (bestPath == null)
                        {
                            bestPath = candidate;
                        }
                    }
                }
                catch { }
            }

            return bestPath;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                if (_ctrlPtr != IntPtr.Zero)
                {
                    var close = GetVtblDelegate<CtrlCloseFn>(_ctrlPtr, 24);
                    close(_ctrlPtr);
                }
            }
            catch { }
            if (_wvPtr != IntPtr.Zero) { Marshal.Release(_wvPtr); _wvPtr = IntPtr.Zero; }
            if (_ctrlPtr != IntPtr.Zero) { Marshal.Release(_ctrlPtr); _ctrlPtr = IntPtr.Zero; }
            if (_envPtr != IntPtr.Zero) { Marshal.Release(_envPtr); _envPtr = IntPtr.Zero; }
        }
    }

    internal sealed class ChildProcessJob : IDisposable
    {
        private IntPtr _handle;

        public ChildProcessJob()
        {
            _handle = NativeMethods.CreateJobObject(IntPtr.Zero, null);
            if (_handle == IntPtr.Zero) return;

            var info = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                NativeMethods.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK; // Only the explicitly assigned daemon belongs to the tray.
            int length = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                NativeMethods.SetInformationJobObject(_handle, NativeMethods.JobObjectExtendedLimitInformation, ptr, (uint)length);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        public void AddProcess(Process process)
        {
            if (_handle == IntPtr.Zero || process == null) return;
            try
            {
                NativeMethods.AssignProcessToJobObject(_handle, process.Handle);
            }
            catch { }
        }

        public void Dispose()
        {
            if (_handle != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_handle);
                _handle = IntPtr.Zero;
            }
        }
    }

    internal enum TrayBadgeState
    {
        Starting,
        Alert,
        Waiting,
        Attached,
        NeedsRestart,
        Paused
    }

    internal static class TrayIconFactory
    {
        // Matches T3Tools project palette (--pt-card #14161b, --pt-bg #0b0c0f, --pt-accent #6366f1)
        public static Icon CreateStatusIcon(TrayBadgeState state, int size)
        {
            using (var bmp = new Bitmap(size, size))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                g.Clear(Color.Transparent);

                float pad = Math.Max(1f, size * 0.06f);
                float radius = Math.Max(3f, size * 0.24f);
                var rect = new RectangleF(pad, pad, size - pad * 2f - 1f, size - pad * 2f - 1f);

                using (var path = CreateRoundedRect(rect, radius))
                using (var bg = new LinearGradientBrush(rect, Color.FromArgb(27, 30, 37), Color.FromArgb(11, 12, 15), 45f))
                using (var borderPen = new Pen(Color.FromArgb(99, 102, 241), Math.Max(1f, size * 0.06f)))
                {
                    g.FillPath(bg, path);
                    g.DrawPath(borderPen, path);
                }

                float fontSize = size * 0.42f;
                using (var font = new Font("Segoe UI", fontSize, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var textBrush = new SolidBrush(Color.FromArgb(243, 244, 246)))
                using (var sf = new StringFormat())
                {
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    var textRect = new RectangleF(0f, size * 0.02f, size, size * 0.92f);
                    g.DrawString("T3", font, textBrush, textRect, sf);
                }

                Color dotColor;
                switch (state)
                {
                    case TrayBadgeState.Alert:
                        dotColor = Color.FromArgb(239, 68, 68);
                        break;
                    case TrayBadgeState.Attached:
                        dotColor = Color.FromArgb(34, 197, 94);   // --pt-success
                        break;
                    case TrayBadgeState.NeedsRestart:
                        dotColor = Color.FromArgb(245, 158, 11);  // --pt-warning
                        break;
                    case TrayBadgeState.Waiting:
                        dotColor = Color.FromArgb(99, 102, 241);  // --pt-accent
                        break;
                    default:
                        dotColor = Color.FromArgb(156, 163, 175); // --pt-muted
                        break;
                }

                float dotSize = Math.Max(5f, size * 0.34f);
                float dotX = size - dotSize - 1f;
                float dotY = size - dotSize - 1f;
                using (var ringBrush = new SolidBrush(Color.FromArgb(11, 12, 15)))
                using (var dotBrush = new SolidBrush(dotColor))
                {
                    g.FillEllipse(ringBrush, dotX - 1.2f, dotY - 1.2f, dotSize + 2.4f, dotSize + 2.4f);
                    g.FillEllipse(dotBrush, dotX, dotY, dotSize, dotSize);
                }

                IntPtr hIcon = bmp.GetHicon();
                try
                {
                    using (var temp = Icon.FromHandle(hIcon))
                    {
                        return (Icon)temp.Clone();
                    }
                }
                finally
                {
                    NativeMethods.DestroyIcon(hIcon);
                }
            }
        }

        private static GraphicsPath CreateRoundedRect(RectangleF bounds, float radius)
        {
            float d = radius * 2f;
            var path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class FluentTrayMenuEntry
    {
        public bool IsSeparator;
        public bool IsHeader;
        public string Text;
        public string Glyph;
        public bool IsAccentWarning;
        public Action OnClick;

        public static FluentTrayMenuEntry Separator()
        {
            return new FluentTrayMenuEntry { IsSeparator = true };
        }

        public static FluentTrayMenuEntry Header(string text)
        {
            return new FluentTrayMenuEntry
            {
                IsHeader = true,
                Text = text
            };
        }

        public static FluentTrayMenuEntry Item(string text, string glyph, Action onClick, bool isAccentWarning = false)
        {
            return new FluentTrayMenuEntry
            {
                IsSeparator = false,
                IsHeader = false,
                Text = text,
                Glyph = glyph,
                IsAccentWarning = isAccentWarning,
                OnClick = onClick
            };
        }
    }

    // Magpie-inspired minimalist Windows 11 Fluent MenuFlyout for system tray
    internal sealed class FluentTrayMenuForm : Form
    {
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int CS_DROPSHADOW = 0x00020000;

        private readonly List<FluentTrayMenuEntry> _entries;
        private readonly List<Rectangle> _entryRects = new List<Rectangle>();
        private readonly bool _isDark;
        private readonly Color _bgColor;
        private readonly Color _borderColor;
        private readonly Color _textColor;
        private readonly Color _mutedTextColor;
        private readonly Color _iconColor;
        private readonly Color _warnColor;
        private readonly Color _hoverColor;
        private readonly Color _pressedColor;
        private readonly Color _sepColor;

        private readonly Font _textFont;
        private readonly Font _headerFont;
        private readonly Font _iconFont;

        private bool _hasWin11RoundedChrome;
        private float _scale = 1f;
        private int _hoverIndex = -1;
        private int _pressedIndex = -1;
        private bool _closing;

        public FluentTrayMenuForm(List<FluentTrayMenuEntry> entries, bool isDark)
        {
            _entries = entries ?? new List<FluentTrayMenuEntry>();
            _isDark = isDark;

            if (_isDark)
            {
                _bgColor = Color.FromArgb(44, 44, 44);
                _borderColor = Color.FromArgb(67, 67, 67);
                _textColor = Color.FromArgb(255, 255, 255);
                _mutedTextColor = Color.FromArgb(158, 158, 158);
                _iconColor = Color.FromArgb(232, 232, 232);
                _warnColor = Color.FromArgb(245, 158, 11);
                _hoverColor = Color.FromArgb(56, 56, 56);
                _pressedColor = Color.FromArgb(51, 51, 51);
                _sepColor = Color.FromArgb(61, 61, 61);
            }
            else
            {
                _bgColor = Color.FromArgb(249, 249, 249);
                _borderColor = Color.FromArgb(220, 220, 220);
                _textColor = Color.FromArgb(26, 26, 26);
                _mutedTextColor = Color.FromArgb(107, 107, 107);
                _iconColor = Color.FromArgb(51, 51, 51);
                _warnColor = Color.FromArgb(217, 119, 6);
                _hoverColor = Color.FromArgb(239, 239, 239);
                _pressedColor = Color.FromArgb(232, 232, 232);
                _sepColor = Color.FromArgb(229, 229, 229);
            }

            this.FormBorderStyle = FormBorderStyle.None;
            this.ShowInTaskbar = false;
            this.TopMost = true;
            this.StartPosition = FormStartPosition.Manual;
            this.BackColor = _bgColor;
            this.Opacity = 0.98;
            this.KeyPreview = true;
            this.SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true
            );

            _textFont = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular, GraphicsUnit.Point);
            _headerFont = new Font("Segoe UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point);
            _iconFont = CreateFluentIconFont(10.5f);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TOOLWINDOW;
                if (Environment.OSVersion.Version.Build < 22000)
                {
                    cp.ClassStyle |= CS_DROPSHADOW;
                }
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            _hasWin11RoundedChrome = NativeMethods.ApplyWin11PopupChrome(this.Handle, _isDark, _borderColor);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_textFont != null) _textFont.Dispose();
                if (_headerFont != null) _headerFont.Dispose();
                if (_iconFont != null) _iconFont.Dispose();
            }
            base.Dispose(disposing);
        }

        private static Font CreateFluentIconFont(float sizePt)
        {
            try
            {
                using (var fc = new InstalledFontCollection())
                {
                    bool hasFluent = false;
                    bool hasMdl2 = false;
                    for (int i = 0; i < fc.Families.Length; i++)
                    {
                        string n = fc.Families[i].Name;
                        if (string.Equals(n, "Segoe Fluent Icons", StringComparison.OrdinalIgnoreCase)) hasFluent = true;
                        else if (string.Equals(n, "Segoe MDL2 Assets", StringComparison.OrdinalIgnoreCase)) hasMdl2 = true;
                    }
                    if (hasFluent) return new Font("Segoe Fluent Icons", sizePt, FontStyle.Regular, GraphicsUnit.Point);
                    if (hasMdl2) return new Font("Segoe MDL2 Assets", sizePt, FontStyle.Regular, GraphicsUnit.Point);
                }
            }
            catch { }
            return null;
        }

        private int S(float logicalPx)
        {
            return Math.Max(1, (int)Math.Round(logicalPx * _scale));
        }

        public void ShowAtCursor(Point anchor)
        {
            CreateHandle();
            _scale = NativeMethods.GetWindowScale(this.Handle);
            if (_scale <= 0.1f)
            {
                using (Graphics g = CreateGraphics()) { _scale = g.DpiX / 96f; }
            }

            Size menuSize = ComputeLayout();
            this.ClientSize = menuSize;

            Screen scr = Screen.FromPoint(anchor);
            Rectangle wa = scr.WorkingArea;
            Rectangle bounds = scr.Bounds;
            int gap = S(6);

            // Place above the cursor by default (standard Windows 11 taskbar tray behavior),
            // shifting inward if near screen edges.
            int x = anchor.X;
            int y = anchor.Y - menuSize.Height - gap;

            if (x + menuSize.Width > wa.Right - gap)
            {
                x = anchor.X - menuSize.Width;
            }
            if (x + menuSize.Width > bounds.Right - gap)
            {
                x = bounds.Right - menuSize.Width - gap;
            }
            if (x < bounds.Left + gap)
            {
                x = bounds.Left + gap;
            }

            if (y < bounds.Top + gap)
            {
                y = anchor.Y + gap;
            }
            if (y + menuSize.Height > bounds.Bottom - gap)
            {
                y = bounds.Bottom - menuSize.Height - gap;
            }

            this.Location = new Point(x, y);
            this.Show();
            NativeMethods.SetForegroundWindow(this.Handle);
            this.Activate();
        }

        private Size ComputeLayout()
        {
            _entryRects.Clear();
            int padX = S(4);
            int padY = S(4);
            int itemH = S(32);
            int headerH = S(26);
            int itemGap = S(2);
            int sepH = S(9);
            int leftInset = S(11);
            int iconW = S(16);
            int iconTextGap = S(12);
            int rightInset = S(16);
            int minWidth = S(156);

            int maxContentW = minWidth;
            using (Graphics g = CreateGraphics())
            {
                for (int i = 0; i < _entries.Count; i++)
                {
                    var entry = _entries[i];
                    if (entry.IsSeparator) continue;
                    Font f = entry.IsHeader ? _headerFont : _textFont;
                    Size textSz = TextRenderer.MeasureText(
                        g,
                        entry.Text ?? "",
                        f,
                        new Size(int.MaxValue, int.MaxValue),
                        TextFormatFlags.NoPadding | TextFormatFlags.SingleLine
                    );
                    int rowW = entry.IsHeader
                        ? (padX * 2 + leftInset + textSz.Width + rightInset)
                        : (padX * 2 + leftInset + iconW + iconTextGap + textSz.Width + rightInset);
                    if (rowW > maxContentW) maxContentW = rowW;
                }
            }

            int y = padY;
            for (int i = 0; i < _entries.Count; i++)
            {
                var entry = _entries[i];
                if (entry.IsSeparator)
                {
                    _entryRects.Add(new Rectangle(0, y, maxContentW, sepH));
                    y += sepH;
                }
                else if (entry.IsHeader)
                {
                    _entryRects.Add(new Rectangle(padX, y, maxContentW - padX * 2, headerH));
                    y += headerH;
                }
                else
                {
                    _entryRects.Add(new Rectangle(padX, y, maxContentW - padX * 2, itemH));
                    y += itemH;
                    if (i + 1 < _entries.Count && !_entries[i + 1].IsSeparator && !_entries[i + 1].IsHeader)
                    {
                        y += itemGap;
                    }
                }
            }

            return new Size(maxContentW, y + padY);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.Clear(_bgColor);

            int radius = S(4);
            int leftInset = S(11);
            int iconW = S(16);
            int iconTextGap = S(12);

            for (int i = 0; i < _entries.Count && i < _entryRects.Count; i++)
            {
                var entry = _entries[i];
                Rectangle r = _entryRects[i];

                if (entry.IsSeparator)
                {
                    int lineY = r.Top + r.Height / 2;
                    using (var pen = new Pen(_sepColor, 1f))
                    {
                        g.DrawLine(pen, S(1), lineY, this.ClientSize.Width - S(1) - 1, lineY);
                    }
                    continue;
                }

                if (entry.IsHeader)
                {
                    Rectangle hdrRect = new Rectangle(r.Left + leftInset, r.Top, r.Width - leftInset - S(8), r.Height);
                    TextRenderer.DrawText(
                        g,
                        entry.Text ?? "",
                        _headerFont,
                        hdrRect,
                        _mutedTextColor,
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding
                    );
                    continue;
                }

                if (i == _pressedIndex || i == _hoverIndex)
                {
                    Color fill = (i == _pressedIndex) ? _pressedColor : _hoverColor;
                    using (var path = CreateRoundedRectPath(new RectangleF(r.X, r.Y, r.Width - 1f, r.Height - 1f), radius))
                    using (var br = new SolidBrush(fill))
                    {
                        g.FillPath(br, path);
                    }
                }

                Color icColor = entry.IsAccentWarning ? _warnColor : _iconColor;
                Rectangle iconRect = new Rectangle(r.Left + leftInset, r.Top, iconW, r.Height);
                if (_iconFont != null && !string.IsNullOrEmpty(entry.Glyph))
                {
                    TextRenderer.DrawText(
                        g,
                        entry.Glyph,
                        _iconFont,
                        iconRect,
                        icColor,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding
                    );
                }
                else
                {
                    int dot = S(6);
                    using (var br = new SolidBrush(icColor))
                    {
                        g.FillEllipse(br, iconRect.Left + (iconRect.Width - dot) / 2, iconRect.Top + (iconRect.Height - dot) / 2, dot, dot);
                    }
                }

                Rectangle textRect = new Rectangle(
                    iconRect.Right + iconTextGap,
                    r.Top,
                    r.Right - (iconRect.Right + iconTextGap) - S(8),
                    r.Height
                );
                TextRenderer.DrawText(
                    g,
                    entry.Text ?? "",
                    _textFont,
                    textRect,
                    _textColor,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding
                );
            }

            if (!_hasWin11RoundedChrome)
            {
                using (var borderPen = new Pen(_borderColor, 1f))
                {
                    g.DrawRectangle(borderPen, 0, 0, this.ClientSize.Width - 1, this.ClientSize.Height - 1);
                }
            }
        }

        private static GraphicsPath CreateRoundedRectPath(RectangleF bounds, float radius)
        {
            float d = radius * 2f;
            var path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private bool IsActionable(int idx)
        {
            return idx >= 0 && idx < _entries.Count && !_entries[idx].IsSeparator && !_entries[idx].IsHeader;
        }

        private int HitTestItem(Point pt)
        {
            for (int i = 0; i < _entries.Count && i < _entryRects.Count; i++)
            {
                if (!IsActionable(i)) continue;
                if (_entryRects[i].Contains(pt)) return i;
            }
            return -1;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int idx = HitTestItem(e.Location);
            if (idx != _hoverIndex)
            {
                _hoverIndex = idx;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (_hoverIndex != -1 || _pressedIndex != -1)
            {
                _hoverIndex = -1;
                _pressedIndex = -1;
                Invalidate();
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            int idx = HitTestItem(e.Location);
            if (idx != _pressedIndex)
            {
                _pressedIndex = idx;
                Invalidate();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            int idx = HitTestItem(e.Location);
            int pressed = _pressedIndex;
            _pressedIndex = -1;
            Invalidate();
            if (idx >= 0 && idx == pressed)
            {
                ExecuteEntry(idx);
            }
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape)
            {
                e.Handled = true;
                Dismiss();
            }
            else if (e.KeyCode == Keys.Down)
            {
                e.Handled = true;
                MoveSelection(1);
            }
            else if (e.KeyCode == Keys.Up)
            {
                e.Handled = true;
                MoveSelection(-1);
            }
            else if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space)
            {
                e.Handled = true;
                if (IsActionable(_hoverIndex))
                {
                    ExecuteEntry(_hoverIndex);
                }
            }
        }

        private void MoveSelection(int delta)
        {
            if (_entries.Count == 0) return;
            int cur = _hoverIndex;
            for (int step = 0; step < _entries.Count; step++)
            {
                if (cur < 0)
                {
                    cur = delta > 0 ? 0 : _entries.Count - 1;
                }
                else
                {
                    cur = (cur + delta + _entries.Count) % _entries.Count;
                }
                if (IsActionable(cur))
                {
                    _hoverIndex = cur;
                    Invalidate();
                    return;
                }
            }
        }

        private void ExecuteEntry(int index)
        {
            if (index < 0 || index >= _entries.Count) return;
            Action callback = _entries[index].OnClick;
            Dismiss();
            if (callback != null)
            {
                try { callback(); } catch { }
            }
        }

        protected override void OnDeactivate(EventArgs e)
        {
            base.OnDeactivate(e);
            Dismiss();
        }

        public void Dismiss()
        {
            if (_closing) return;
            _closing = true;
            try { this.Close(); } catch { }
        }
    }

    internal sealed class T3ToolsTrayForm : Form
    {
        private const string AutoStartRegPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string AutoStartValueName = "T3Tools";

        private static readonly Color ColBgDark = Color.FromArgb(11, 12, 15);        // --pt-bg #0b0c0f
        private static readonly Color ColFgDark = Color.FromArgb(243, 244, 246);     // --pt-fg #f3f4f6
        private static readonly Color ColMutedDark = Color.FromArgb(156, 163, 175);  // --pt-muted #9ca3af
        private static readonly Color ColAccentDark = Color.FromArgb(99, 102, 241);  // --pt-accent #6366f1

        private static readonly Color ColBgLight = Color.FromArgb(255, 255, 255);    // --pt-bg #ffffff
        private static readonly Color ColFgLight = Color.FromArgb(17, 24, 39);       // --pt-fg #111827
        private static readonly Color ColMutedLight = Color.FromArgb(100, 116, 139); // --pt-muted #64748b
        private static readonly Color ColAccentLight = Color.FromArgb(79, 70, 229);  // --pt-accent #4f46e5

        private readonly bool _forceStartInTray;
        private readonly string _pluginDataDir;
        private readonly string _settingsPath;
        private readonly string _runtimePath;
        private readonly string _trayConfigPath;
        private readonly string _authToken;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        private readonly ChildProcessJob _childJob = new ChildProcessJob();
        private Process _daemonProcess;
        private bool _ownsDaemon;
        private string _daemonUrl = "http://127.0.0.1:17373";
        private int _daemonPid;
        private string _daemonVersion = "0.1.0";
        private string _lastDaemonError = "";
        private bool _daemonReady;

        private bool _autoAttach = true;
        private bool _minimizeToTray = true;
        private bool _startMinimizedToTray = false;
        private bool _autoPatchLauncher = true;
        private bool _launchOnStartup = false;

        private bool _cdpConnected;
        private int _cdpTargets;
        private int _cdpPort;
        private bool _t3UiRunning;
        private bool _wasAttachedOnce;
        private bool _shownMinimizeHint;
        private volatile bool _exiting;
        private readonly object _daemonStartLock = new object();
        private int _pollingNow;
        private bool _daemonBootStarted;
        private bool _webViewStarted;
        private bool _pageReady;
        private bool _darkTheme = true;
        private DateTime _lastLocalThemeChangeUtc = DateTime.MinValue;
        private DateTime _lastShownUtc = DateTime.MinValue;
        private int _unreadErrors;
        private int _alertPid;
        private int _lastNotifiedAlertSeq = -1;
        private bool _errorBalloon;
        private TrayBadgeState _currentBadge = TrayBadgeState.Starting;

        private Panel _webHostPanel;
        private Label _fallbackLabel;
        private Button _fallbackOpenBtn;
        private WebView2Host _webView;

        private NotifyIcon _trayIcon;
        private FluentTrayMenuForm _activeTrayMenu;
        private string _pendingView;

        private System.Windows.Forms.Timer _pollTimer;
        private System.Windows.Forms.Timer _idleMemTimer;
        private Thread _ipcThread;
        private EventWaitHandle _wakeEvent;
        private EventWaitHandle _quitEvent;
        private ManualResetEvent _ipcStopEvent;

        public T3ToolsTrayForm(bool forceStartInTray, EventWaitHandle wakeEvent, EventWaitHandle quitEvent)
        {
            _forceStartInTray = forceStartInTray;
            _wakeEvent = wakeEvent;
            _quitEvent = quitEvent;
            _ipcStopEvent = new ManualResetEvent(false);

            string home = Environment.GetEnvironmentVariable("USERPROFILE");
            if (string.IsNullOrEmpty(home))
            {
                home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            }
            string overrideDir = Environment.GetEnvironmentVariable("T3TOOLS_DIR");
            _pluginDataDir = string.IsNullOrEmpty(overrideDir) ? Path.Combine(home, ".t3tools") : overrideDir;
            _settingsPath = Path.Combine(_pluginDataDir, "settings.json");
            _runtimePath = Path.Combine(_pluginDataDir, "runtime.json");
            _trayConfigPath = Path.Combine(_pluginDataDir, "tray-config.json");
            _authToken = GenerateHexToken(24);

            LoadInitialPreferences();
            InitializeFormUi();
            InitializeTrayIcon();
            StartIpcListener();

            SystemEvents.SessionEnding += OnSessionEnding;
        }

        private static string GenerateHexToken(int byteCount)
        {
            byte[] buf = new byte[byteCount];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(buf);
            }
            var sb = new StringBuilder(byteCount * 2);
            for (int i = 0; i < buf.Length; i++) sb.Append(buf[i].ToString("x2"));
            return sb.ToString();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            NativeMethods.ApplyTitleBarTheme(this.Handle, _darkTheme);
        }

        private void StartDaemonBootOnce()
        {
            if (_daemonBootStarted) return;
            _daemonBootStarted = true;
            ThreadPool.QueueUserWorkItem(delegate { EnsureDaemonStartedAndPoll(); });
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            _lastShownUtc = DateTime.UtcNow;
            StartDaemonBootOnce();
            EnsureWebViewInitialized();
        }

        protected override void SetVisibleCore(bool value)
        {
            if (!IsHandleCreated && (_forceStartInTray || _startMinimizedToTray))
            {
                CreateHandle();
                value = false;
                StartDaemonBootOnce();
            }
            base.SetVisibleCore(value);
        }

        private void LoadInitialPreferences()
        {
            try
            {
                if (File.Exists(_settingsPath))
                {
                    var dict = _json.Deserialize<Dictionary<string, object>>(File.ReadAllText(_settingsPath, Encoding.UTF8));
                    if (dict != null)
                    {
                        _autoAttach = GetBool(dict, "autoAttachT3", true);
                        _minimizeToTray = GetBool(dict, "minimizeToTray", true);
                        _startMinimizedToTray = GetBool(dict, "startMinimizedToTray", false);
                        _autoPatchLauncher = GetBool(dict, "autoPatchLauncher", true);
                        string theme = GetString(dict, "theme", "dark");
                        _darkTheme = !string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase);
                        int port = GetInt(dict, "port", 17373);
                        if (port >= 1024 && port <= 65535)
                        {
                            _daemonUrl = "http://127.0.0.1:" + port;
                        }
                    }
                }
            }
            catch { }

            _launchOnStartup = ReadAutoStartEnabled();
        }

        private void InitializeFormUi()
        {
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int w = Math.Min(1160, Math.Max(820, (int)(wa.Width * 0.82)));
            int h = Math.Min(780, Math.Max(580, (int)(wa.Height * 0.84)));

            Color initBg = _darkTheme ? ColBgDark : ColBgLight;
            Color initFg = _darkTheme ? ColFgDark : ColFgLight;
            Color initMuted = _darkTheme ? ColMutedDark : ColMutedLight;
            Color initAccent = _darkTheme ? ColAccentDark : ColAccentLight;

            this.Text = "T3Tools";
            this.FormBorderStyle = FormBorderStyle.Sizable;
            this.MaximizeBox = true;
            this.MinimizeBox = true;
            this.MinimumSize = new Size(760, 520);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.ClientSize = new Size(w, h);
            this.BackColor = initBg;
            this.ForeColor = initFg;
            this.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            this.Icon = TrayIconFactory.CreateStatusIcon(TrayBadgeState.Starting, 32);

            this.Resize += OnFormResize;
            this.FormClosing += OnFormClosing;

            _webHostPanel = new Panel();
            _webHostPanel.Dock = DockStyle.Fill;
            _webHostPanel.BackColor = initBg;
            _webHostPanel.Resize += delegate
            {
                if (_webView != null) _webView.UpdateBounds();
            };
            this.Controls.Add(_webHostPanel);

            _fallbackLabel = new Label();
            _fallbackLabel.Text = "正在启动 T3Tools 并加载界面...";
            _fallbackLabel.ForeColor = initMuted;
            _fallbackLabel.BackColor = initBg;
            _fallbackLabel.AutoSize = false;
            _fallbackLabel.TextAlign = ContentAlignment.MiddleCenter;
            _fallbackLabel.Dock = DockStyle.Fill;
            _webHostPanel.Controls.Add(_fallbackLabel);

            _fallbackOpenBtn = new Button();
            _fallbackOpenBtn.Text = "在浏览器打开看板";
            _fallbackOpenBtn.Visible = false;
            _fallbackOpenBtn.FlatStyle = FlatStyle.Flat;
            _fallbackOpenBtn.FlatAppearance.BorderSize = 0;
            _fallbackOpenBtn.BackColor = initAccent;
            _fallbackOpenBtn.ForeColor = Color.White;
            _fallbackOpenBtn.Size = new Size(164, 36);
            _fallbackOpenBtn.Anchor = AnchorStyles.None;
            _fallbackOpenBtn.Click += delegate { OpenDashboardInBrowser(); };
            _webHostPanel.Controls.Add(_fallbackOpenBtn);

            _pollTimer = new System.Windows.Forms.Timer();
            _pollTimer.Interval = 2000;
            _pollTimer.Tick += delegate { PollStatusAsync(); };
            _pollTimer.Start();

            // Defer WebView2 low-memory trim until hidden for 3 minutes so tray clicks restore instantaneously
            _idleMemTimer = new System.Windows.Forms.Timer();
            _idleMemTimer.Interval = 180000;
            _idleMemTimer.Tick += delegate
            {
                _idleMemTimer.Stop();
                if (!this.Visible && _webView != null && _webView.IsReady)
                {
                    _webView.SetMemoryLow(true);
                }
            };
        }

        private void ApplyWindowTheme(bool dark)
        {
            _darkTheme = dark;
            Color bg = dark ? ColBgDark : ColBgLight;
            Color fg = dark ? ColFgDark : ColFgLight;
            Color muted = dark ? ColMutedDark : ColMutedLight;
            Color accent = dark ? ColAccentDark : ColAccentLight;

            this.BackColor = bg;
            this.ForeColor = fg;
            if (_webHostPanel != null) _webHostPanel.BackColor = bg;
            if (_fallbackLabel != null)
            {
                _fallbackLabel.BackColor = bg;
                _fallbackLabel.ForeColor = muted;
            }
            if (_fallbackOpenBtn != null) _fallbackOpenBtn.BackColor = accent;
            if (this.IsHandleCreated) NativeMethods.ApplyTitleBarTheme(this.Handle, dark);
            if (_webView != null) _webView.SetBackgroundColor(bg);
        }

        private void EnsureWebViewInitialized()
        {
            if (_webViewStarted || !_daemonReady || _exiting || this.IsDisposed) return;
            _webViewStarted = true;
            try
            {
                string wvData = Path.Combine(_pluginDataDir, "webview2-data");
                _webView = new WebView2Host(
                    _webHostPanel,
                    wvData,
                    OnWebMessage,
                    OnWebViewReady,
                    OnWebViewError
                );
                _webView.SetBackgroundColor(_darkTheme ? ColBgDark : ColBgLight);
                string initialUrl = _daemonUrl + "/?desktop=1";
                if (!string.IsNullOrEmpty(_pendingView))
                {
                    initialUrl += "&view=" + Uri.EscapeDataString(_pendingView);
                }
                _webView.Initialize(initialUrl, this.Visible);
            }
            catch (Exception ex)
            {
                OnWebViewError(ex.Message);
            }
        }

        private void OnWebViewReady()
        {
            SafeInvoke(delegate
            {
                if (_fallbackLabel != null) _fallbackLabel.Visible = false;
                if (_fallbackOpenBtn != null) _fallbackOpenBtn.Visible = false;
                if (_webView != null)
                {
                    _webView.UpdateBounds();
                    _webView.SetVisible(this.Visible);
                    _webView.SetMemoryLow(!this.Visible);
                }
                PushHostStateToWebView();
            });
        }

        private void OnWebViewError(string reason)
        {
            SafeInvoke(delegate
            {
                if (_fallbackLabel != null)
                {
                    _fallbackLabel.Visible = true;
                    _fallbackLabel.Text = "内嵌 WebView2 初始化失败：" + reason + "\n\n后台自动吸附与托盘服务仍在正常运行，可点击下方按钮在浏览器打开完整看板。";
                }
                if (_fallbackOpenBtn != null)
                {
                    _fallbackOpenBtn.Location = new Point(
                        (_webHostPanel.ClientSize.Width - _fallbackOpenBtn.Width) / 2,
                        (_webHostPanel.ClientSize.Height / 2) + 46
                    );
                    _fallbackOpenBtn.Visible = true;
                    _fallbackOpenBtn.BringToFront();
                }
            });
        }

        private void OnWebMessage(string rawJson)
        {
            try
            {
                var msg = _json.Deserialize<Dictionary<string, object>>(rawJson);
                if (msg == null) return;
                string action = GetString(msg, "action", "");

                if (action == "getHostState")
                {
                    _pageReady = true;
                    PushHostStateToWebView();
                    FlushPendingViewToWebView();
                }
                else if (action == "hideToTray")
                {
                    SafeInvoke(delegate { HideToTray(true); });
                }
                else if (action == "openExternal")
                {
                    OpenDashboardInBrowser();
                }
                else if (action == "exitApp")
                {
                    SafeInvoke(delegate { ExitApplication(); });
                }
                else if (action == "setAutoStart")
                {
                    bool want = GetBool(msg, "enabled", false);
                    bool ok = WriteAutoStartEnabled(want);
                    _launchOnStartup = ok ? want : ReadAutoStartEnabled();
                    PushHostStateToWebView();
                }
                else if (action == "setTheme")
                {
                    string theme = GetString(msg, "theme", "dark");
                    bool nextDark = !string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase);
                    _lastLocalThemeChangeUtc = DateTime.UtcNow;
                    SafeInvoke(delegate { ApplyWindowTheme(nextDark); });
                }
                else if (action == "settingsChanged")
                {
                    var s = GetDict(msg, "settings");
                    if (s != null)
                    {
                        _autoAttach = GetBool(s, "autoAttachT3", _autoAttach);
                        _minimizeToTray = GetBool(s, "minimizeToTray", _minimizeToTray);
                        _startMinimizedToTray = GetBool(s, "startMinimizedToTray", _startMinimizedToTray);
                        _autoPatchLauncher = GetBool(s, "autoPatchLauncher", _autoPatchLauncher);
                        if (s.ContainsKey("theme"))
                        {
                            string nextTheme = GetString(s, "theme", "");
                            if (string.Equals(nextTheme, "light", StringComparison.OrdinalIgnoreCase) ||
                                string.Equals(nextTheme, "dark", StringComparison.OrdinalIgnoreCase))
                            {
                                bool nextDark = !string.Equals(nextTheme, "light", StringComparison.OrdinalIgnoreCase);
                                _lastLocalThemeChangeUtc = DateTime.UtcNow;
                                SafeInvoke(delegate { ApplyWindowTheme(nextDark); });
                            }
                        }
                    }
                    PollStatusAsync();
                }
                else if (action == "confirmRelaunchT3")
                {
                    SafeInvoke(delegate { ConfirmAndRelaunchT3(); });
                }
            }
            catch { }
        }

        private void PushHostStateToWebView()
        {
            if (_webView == null || !_webView.IsReady) return;
            var payload = new Dictionary<string, object>();
            payload["type"] = "hostState";
            payload["isDesktop"] = true;
            payload["t3UiRunning"] = _t3UiRunning;
            payload["launchOnStartup"] = _launchOnStartup;
            payload["cdpConnected"] = _cdpConnected;
            string json = _json.Serialize(payload);
            SafeInvoke(delegate
            {
                if (_webView != null && _webView.IsReady) _webView.PostJson(json);
            });
        }

        private void PushToastToWebView(string message)
        {
            if (string.IsNullOrEmpty(message)) return;
            var payload = new Dictionary<string, object>();
            payload["type"] = "toast";
            payload["message"] = message;
            string json = _json.Serialize(payload);
            SafeInvoke(delegate
            {
                if (_webView != null && _webView.IsReady) _webView.PostJson(json);
            });
        }

        private void FlushPendingViewToWebView()
        {
            if (!_pageReady || string.IsNullOrEmpty(_pendingView) || _webView == null || !_webView.IsReady) return;
            string v = _pendingView;
            _pendingView = null;
            SafeInvoke(delegate
            {
                if (_webView != null && _webView.IsReady)
                {
                    _webView.PostJson(v == "errors" ? "{\"type\":\"navigate\",\"view\":\"models\",\"focusErrors\":true}" :
                        "{\"type\":\"navigate\",\"view\":\"" + v + "\"}");
                }
            });
        }

        private void InitializeTrayIcon()
        {
            _trayIcon = new NotifyIcon();
            _trayIcon.Icon = TrayIconFactory.CreateStatusIcon(TrayBadgeState.Starting, 32);
            _trayIcon.Text = "T3Tools - 正在启动...";
            _trayIcon.Visible = true;
            _trayIcon.BalloonTipClicked += delegate { ShowMainWindow(_errorBalloon ? "errors" : null); };
            _trayIcon.MouseUp += delegate(object s, MouseEventArgs me)
            {
                if (me.Button == MouseButtons.Right)
                {
                    ShowFluentTrayMenu(Cursor.Position);
                }
                else if (me.Button == MouseButtons.Left)
                {
                    DismissActiveTrayMenu();
                    if (this.Visible)
                    {
                        if ((DateTime.UtcNow - _lastShownUtc).TotalMilliseconds > 400)
                        {
                            HideToTray(false);
                        }
                    }
                    else
                    {
                        ShowMainWindow();
                    }
                }
            };
        }

        private void DismissActiveTrayMenu()
        {
            if (_activeTrayMenu != null)
            {
                var prev = _activeTrayMenu;
                _activeTrayMenu = null;
                prev.Dismiss();
            }
        }

        private void ShowFluentTrayMenu(Point cursorPos)
        {
            DismissActiveTrayMenu();

            string verLabel = "T3Tools v" + (string.IsNullOrEmpty(_daemonVersion) ? "0.1.0" : _daemonVersion);
            var entries = new List<FluentTrayMenuEntry>();
            entries.Add(FluentTrayMenuEntry.Header(verLabel));
            entries.Add(FluentTrayMenuEntry.Separator());
            entries.Add(FluentTrayMenuEntry.Item(
                "主窗口",
                "\uE80F",
                delegate { ShowMainWindow(); }
            ));
            entries.Add(FluentTrayMenuEntry.Item(
                "重启",
                "\uE72C",
                delegate { RestartApplication(); }
            ));
            entries.Add(FluentTrayMenuEntry.Separator());
            entries.Add(FluentTrayMenuEntry.Item(
                "退出",
                "\uE7E8",
                delegate { ExitApplication(); }
            ));

            bool trayDark = NativeMethods.IsSystemTrayDarkTheme();
            var menu = new FluentTrayMenuForm(entries, trayDark);
            menu.FormClosed += delegate
            {
                if (ReferenceEquals(_activeTrayMenu, menu))
                {
                    _activeTrayMenu = null;
                }
                menu.Dispose();
            };
            _activeTrayMenu = menu;
            menu.ShowAtCursor(cursorPos);
        }

        private void StartIpcListener()
        {
            _ipcThread = new Thread(delegate()
            {
                var handles = new WaitHandle[] { _ipcStopEvent, _wakeEvent, _quitEvent };
                while (true)
                {
                    int idx = WaitHandle.WaitAny(handles);
                    if (idx == 0) break;
                    if (idx == 1)
                    {
                        SafeInvoke(delegate { ShowMainWindow(); });
                    }
                    else if (idx == 2)
                    {
                        SafeInvoke(delegate { ExitApplication(); });
                        break;
                    }
                }
            });
            _ipcThread.IsBackground = true;
            _ipcThread.Start();
        }

        private void OnFormResize(object sender, EventArgs e)
        {
            if (this.WindowState == FormWindowState.Minimized && _minimizeToTray)
            {
                HideToTray(true);
            }
            else if (_webView != null)
            {
                _webView.UpdateBounds();
            }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!_exiting && _minimizeToTray && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray(true);
                return;
            }
            CleanupBeforeExit();
        }

        private void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            _exiting = true;
            SafeInvoke(CleanupBeforeExit);
        }

        protected override void WndProc(ref Message m)
        {
            const int WM_SYSCOMMAND = 0x0112;
            const int SC_MINIMIZE = 0xF020;
            if (m.Msg == WM_SYSCOMMAND && ((int)m.WParam & 0xFFF0) == SC_MINIMIZE && _minimizeToTray && !_exiting)
            {
                HideToTray(true);
                return;
            }
            base.WndProc(ref m);
        }

        private void HideToTray(bool showBalloon)
        {
            // Never toggle Form.ShowInTaskbar after creation: WinForms destroys/recreates the HWND
            // and breaks WebView2's parent surface. Form.Hide() removes the taskbar button natively.
            this.Hide();
            if (this.WindowState == FormWindowState.Minimized)
            {
                this.WindowState = FormWindowState.Normal;
            }
            if (_idleMemTimer != null)
            {
                _idleMemTimer.Stop();
                _idleMemTimer.Start();
            }
            if (showBalloon && !_shownMinimizeHint && _trayIcon != null)
            {
                _shownMinimizeHint = true;
                try
                {
                    _errorBalloon = false;
                    _trayIcon.ShowBalloonTip(
                        2400,
                        "T3Tools 已缩放到托盘",
                        "正在后台自动吸附 T3 Code，单击托盘图标可随时恢复窗口。",
                        ToolTipIcon.Info
                    );
                }
                catch { }
            }
        }

        private void ShowMainWindow(string targetView = null)
        {
            if (_exiting) return;
            if (!string.IsNullOrEmpty(targetView))
            {
                _pendingView = targetView;
            }
            _lastShownUtc = DateTime.UtcNow;
            if (_idleMemTimer != null) _idleMemTimer.Stop();
            if (this.WindowState == FormWindowState.Minimized)
            {
                this.WindowState = FormWindowState.Normal;
            }
            if (!this.Visible) this.Show();
            this.Activate();
            NativeMethods.SetForegroundWindow(this.Handle);

            EnsureWebViewInitialized();
            if (_webView != null)
            {
                _webView.SetMemoryLow(false);
                _webView.SetVisible(true);
                _webView.UpdateBounds();
                PushHostStateToWebView();
                FlushPendingViewToWebView();
                _webView.PostJson("{\"type\":\"refresh\"}");
            }
            PollStatusAsync();
        }

        private void SafeInvoke(Action action)
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;
            try
            {
                if (this.InvokeRequired) this.BeginInvoke(action);
                else action();
            }
            catch { }
        }

        private string ResolveCliPath(out string nodeExe)
        {
            nodeExe = null;
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            var candidates = new List<string>();
            candidates.Add(Path.GetFullPath(Path.Combine(exeDir, "..", "bin", "t3tools.mjs")));
            candidates.Add(Path.GetFullPath(Path.Combine(exeDir, "bin", "t3tools.mjs")));

            try
            {
                if (File.Exists(_trayConfigPath))
                {
                    var cfg = _json.Deserialize<Dictionary<string, object>>(File.ReadAllText(_trayConfigPath, Encoding.UTF8));
                    if (cfg != null)
                    {
                        string cfgNode = GetString(cfg, "nodeExe", "");
                        if (!string.IsNullOrEmpty(cfgNode) && File.Exists(cfgNode)) nodeExe = cfgNode;
                        string cfgCli = GetString(cfg, "cliPath", "");
                        if (!string.IsNullOrEmpty(cfgCli)) candidates.Add(cfgCli);
                        string cfgRoot = GetString(cfg, "repoRoot", "");
                        if (!string.IsNullOrEmpty(cfgRoot)) candidates.Add(Path.Combine(cfgRoot, "bin", "t3tools.mjs"));
                    }
                }
            }
            catch { }

            if (string.IsNullOrEmpty(nodeExe)) nodeExe = FindNodeExecutable();

            foreach (string c in candidates)
            {
                if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
            }
            return null;
        }

        private static string FindNodeExecutable()
        {
            string envPath = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in envPath.Split(';'))
            {
                string trimmed = dir.Trim().Trim('"');
                if (string.IsNullOrEmpty(trimmed)) continue;
                string full = Path.Combine(trimmed, "node.exe");
                if (File.Exists(full)) return full;
            }
            string[] fallbacks = new string[]
            {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe"
            };
            foreach (string fb in fallbacks)
            {
                if (File.Exists(fb)) return fb;
            }
            return "node.exe";
        }

        private void EnsureDaemonStartedAndPoll()
        {
            string existingUrl;
            int existingPid;
            if (TryProbeRuntimeDaemon(out existingUrl, out existingPid))
            {
                _daemonUrl = existingUrl;
                _daemonPid = existingPid;
                _ownsDaemon = false;
                _daemonReady = true;
                SafeInvoke(delegate { if (this.Visible) EnsureWebViewInitialized(); });
                PollStatusAsync();
                return;
            }

            string nodeExe;
            string cliPath = ResolveCliPath(out nodeExe);
            if (string.IsNullOrEmpty(cliPath))
            {
                _lastDaemonError = "未找到 bin/t3tools.mjs，请重新运行 scripts/install.ps1";
                SafeInvoke(delegate { OnWebViewError(_lastDaemonError); UpdateTrayIndicator(); });
                return;
            }

            try
            {
                Directory.CreateDirectory(_pluginDataDir);
                var psi = new ProcessStartInfo();
                psi.FileName = nodeExe;
                psi.Arguments = string.Format("\"{0}\" start --tray-host --patch-debug-arg", cliPath);
                psi.WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(cliPath));
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.EnvironmentVariables["T3TOOLS_AUTH_TOKEN"] = _authToken;

                var proc = new Process();
                proc.StartInfo = psi;
                proc.EnableRaisingEvents = true;

                string outLog = Path.Combine(_pluginDataDir, "daemon.out.log");
                string errLog = Path.Combine(_pluginDataDir, "daemon.err.log");
                proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs args)
                {
                    if (args.Data != null) AppendLogSafe(outLog, args.Data);
                };
                proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs args)
                {
                    if (args.Data != null) AppendLogSafe(errLog, args.Data);
                };

                lock (_daemonStartLock)
                {
                    if (_exiting) { proc.Dispose(); return; }
                    proc.Start();
                    _childJob.AddProcess(proc);
                    _daemonProcess = proc;
                    _daemonPid = proc.Id;
                    _ownsDaemon = true;
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                }
                _lastDaemonError = "";

                for (int i = 0; i < 25; i++)
                {
                    if (_exiting || proc.HasExited) break;
                    string probeUrl;
                    int probePid;
                    if (TryProbeRuntimeDaemon(out probeUrl, out probePid))
                    {
                        _daemonUrl = probeUrl;
                        _daemonPid = probePid;
                        _ownsDaemon = probePid == proc.Id;
                        _daemonReady = true;
                        break;
                    }
                    Thread.Sleep(250);
                }

                if (!_daemonReady)
                {
                    _lastDaemonError = proc.HasExited
                        ? ("后台守护进程异常退出（退出码 " + proc.ExitCode + "），请查看 ~/.t3tools/daemon.err.log")
                        : "等待后台守护进程响应超时";
                    SafeInvoke(delegate { OnWebViewError(_lastDaemonError); });
                }
                else
                {
                    SafeInvoke(delegate
                    {
                        if (this.Visible) EnsureWebViewInitialized();
                    });
                }
            }
            catch (Exception ex)
            {
                _lastDaemonError = "启动后台服务失败: " + ex.Message;
                SafeInvoke(delegate { OnWebViewError(_lastDaemonError); });
            }

            PollStatusAsync();
        }

        private static void AppendLogSafe(string path, string line)
        {
            try { File.AppendAllText(path, line + Environment.NewLine, Encoding.UTF8); }
            catch { }
        }

        private bool TryProbeRuntimeDaemon(out string url, out int pid)
        {
            Dictionary<string, object> status;
            return TryProbeRuntimeDaemon(out url, out pid, out status);
        }

        private bool TryProbeRuntimeDaemon(out string url, out int pid, out Dictionary<string, object> data)
        {
            data = null;
            url = _daemonUrl;
            pid = 0;
            string started = null;
            try
            {
                if (File.Exists(_runtimePath))
                {
                    var rt = _json.Deserialize<Dictionary<string, object>>(File.ReadAllText(_runtimePath, Encoding.UTF8));
                    string u = GetString(rt, "url", "");
                    int p = GetInt(rt, "pid", 0);
                    int port = GetInt(rt, "port", 0);
                    if (port < 1 || port > 65535 || u != "http://127.0.0.1:" + port) return false;
                    url = u;
                    pid = p;
                    started = GetString(rt, "startedAtMs", "");
                }
            }
            catch { }

            if (pid <= 0 || string.IsNullOrEmpty(started)) return false;
            try
            {
                var status = HttpGetJson(url + "/api/status", 1200);
                if (status != null && GetBool(status, "ok", false))
                {
                    var payload = GetDict(status, "data");
                    if (GetInt(payload, "pid", 0) != pid || GetString(payload, "startedAtMs", "") != started) return false;
                    data = payload;
                    return true;
                }
            }
            catch { }
            return false;
        }

        private static bool IsT3CodeUiRunning()
        {
            try
            {
                bool found = false;
                Process[] all = Process.GetProcesses();
                for (int i = 0; i < all.Length; i++)
                {
                    Process p = all[i];
                    try
                    {
                        if (found) continue;
                        string name = p.ProcessName;
                        if (string.IsNullOrEmpty(name)) continue;
                        string lower = name.ToLowerInvariant();
                        bool match = lower.StartsWith("t3 code") || lower.StartsWith("t3code") || lower.StartsWith("t3-code") || lower.StartsWith("t3_code");
                        if (!match) continue;
                        if (lower.Contains("uninstall") || lower.Contains("helper") || lower.Contains("update")) continue;
                        if (p.MainWindowHandle != IntPtr.Zero) found = true;
                    }
                    catch { }
                    finally
                    {
                        try { p.Dispose(); } catch { }
                    }
                }
                return found;
            }
            catch { }
            return false;
        }

        private void PollStatusAsync()
        {
            if (_exiting || Interlocked.Exchange(ref _pollingNow, 1) != 0) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { PollStatusWorker(); }
                finally { Interlocked.Exchange(ref _pollingNow, 0); }
            });
        }

        private void PollStatusWorker()
        {
            if (_exiting) return;
            bool running = IsT3CodeUiRunning();

            Dictionary<string, object> statusData;
            string nextUrl;
            int nextPid;
            TryProbeRuntimeDaemon(out nextUrl, out nextPid, out statusData);
            SafeInvoke(delegate { ApplyStatus(running, nextUrl, nextPid, statusData); });
        }

        private void ApplyStatus(bool running, string nextUrl, int nextPid, Dictionary<string, object> statusData)
        {
            if (_exiting) return;
            bool prevUiRunning = _t3UiRunning;
            _t3UiRunning = running;
            if (statusData != null)
            {
                bool moved = _daemonUrl != nextUrl || _daemonPid != nextPid;
                _daemonUrl = nextUrl;
                _daemonPid = nextPid;
                _daemonReady = true;
                _lastDaemonError = "";
                if (moved && _ownsDaemon && (_daemonProcess == null || _daemonProcess.Id != nextPid)) _ownsDaemon = false;
                if (moved && _webView != null)
                {
                    _pageReady = false;
                    _webView.Navigate(nextUrl + "/?desktop=1");
                }
            }
            else
            {
                _daemonReady = false;
                _cdpConnected = false;
                if (string.IsNullOrEmpty(_lastDaemonError)) _lastDaemonError = "后台服务未就绪";
            }

            if (statusData != null)
            {
                _daemonVersion = GetString(statusData, "version", _daemonVersion);
                _daemonPid = GetInt(statusData, "pid", _daemonPid);
                ReadAlerts(statusData);
                var cdp = GetDict(statusData, "cdp");
                if (cdp != null)
                {
                    bool prevConnected = _cdpConnected;
                    _cdpConnected = GetBool(cdp, "connected", false);
                    _cdpTargets = GetInt(cdp, "attachedTargets", 0);
                    _cdpPort = GetInt(cdp, "devToolsPort", 0);
                    if (cdp.ContainsKey("enabled"))
                    {
                        _autoAttach = GetBool(cdp, "enabled", _autoAttach);
                    }
                    if (!prevConnected && _cdpConnected && !_wasAttachedOnce)
                    {
                        _wasAttachedOnce = true;
                        SafeInvoke(delegate
                        {
                            if (!this.Visible && _trayIcon != null)
                            {
                                try
                                {
                                    _errorBalloon = false;
                                    _trayIcon.ShowBalloonTip(
                                        2200,
                                        "T3Tools 已自动吸附到 T3 Code",
                                        string.Format("已挂载到 {0} 个 T3 Code 窗口（端口 {1}）", Math.Max(1, _cdpTargets), _cdpPort),
                                        ToolTipIcon.Info
                                    );
                                }
                                catch { }
                            }
                        });
                    }
                }

                var settings = GetDict(statusData, "settings");
                if (settings != null)
                {
                    _autoAttach = GetBool(settings, "autoAttachT3", _autoAttach);
                    _minimizeToTray = GetBool(settings, "minimizeToTray", _minimizeToTray);
                    _startMinimizedToTray = GetBool(settings, "startMinimizedToTray", _startMinimizedToTray);
                    _autoPatchLauncher = GetBool(settings, "autoPatchLauncher", _autoPatchLauncher);
                    if (settings.ContainsKey("theme"))
                    {
                        string daemonTheme = GetString(settings, "theme", "");
                        if (string.Equals(daemonTheme, "light", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(daemonTheme, "dark", StringComparison.OrdinalIgnoreCase))
                        {
                            bool daemonDark = !string.Equals(daemonTheme, "light", StringComparison.OrdinalIgnoreCase);
                            if (daemonDark != _darkTheme && (DateTime.UtcNow - _lastLocalThemeChangeUtc).TotalSeconds > 3)
                            {
                                SafeInvoke(delegate { ApplyWindowTheme(daemonDark); });
                            }
                        }
                    }
                }
            }

            UpdateTrayIndicator();
            if (this.Visible && _daemonReady && !_webViewStarted) EnsureWebViewInitialized();
            if (this.Visible || prevUiRunning != _t3UiRunning) PushHostStateToWebView();
        }

        private void ReadAlerts(Dictionary<string, object> status)
        {
            var alerts = GetDict(status, "alerts");
            if (alerts == null) return;
            _unreadErrors = GetInt(alerts, "unreadCount", 0);
            int seq = GetInt(alerts, "latestSeq", 0);
            int previous = _lastNotifiedAlertSeq;
            _lastNotifiedAlertSeq = seq;
            int pid = GetInt(status, "pid", 0);
            if (_alertPid != pid || previous < 0) { _alertPid = pid; return; }
            if (seq <= previous) return;
            var cfg = GetDict(GetDict(status, "settings"), "alertConfig");
            if (!GetBool(cfg,"enabled",true) || !GetBool(cfg,"desktopNotification",true) || GetString(cfg,"mode","smart") == "quiet") return;
            object entries;
            var recent = alerts.TryGetValue("recentAlerts",out entries) ? entries as System.Collections.IList : null;
            if (recent == null)
            {
                NotifyModelError(GetDict(alerts,"latestAlert"));
                return;
            }
            for (int i = recent.Count - 1; i >= 0; i--)
            {
                var alert = recent[i] as Dictionary<string,object>;
                if (GetInt(alert,"seq",0) > previous) NotifyModelError(alert);
            }
        }

        private void NotifyModelError(Dictionary<string,object> alert)
        {
            if (!GetBool(alert,"desktopNotify",false)) return;
            string title = GetString(alert,"modelId","模型") + " · " + GetString(alert,"errorLabel","请求失败");
            string body = GetString(alert,"t3ThreadTitle","模型告警") + " · " + GetInt(alert,"countInWindow",1) + " 次";
            var icon = GetString(alert,"severity","warning") == "high" ? ToolTipIcon.Error : ToolTipIcon.Warning;
            SafeInvoke(delegate
            {
                if (_trayIcon == null) return;
                _errorBalloon = true;
                _trayIcon.ShowBalloonTip(5000,title,body,icon);
            });
        }

        private void UpdateTrayIndicator()
        {
            if (this.IsDisposed) return;

            TrayBadgeState nextBadge;
            string trayTooltip;

            if (!string.IsNullOrEmpty(_lastDaemonError))
            {
                nextBadge = TrayBadgeState.Paused;
                trayTooltip = "T3Tools - 服务异常";
            }
            else if (_daemonReady && _unreadErrors > 0)
            {
                nextBadge = TrayBadgeState.Alert;
                trayTooltip = string.Format("T3Tools - 有 {0} 条未处理模型错误", _unreadErrors);
            }
            else if (!_autoAttach)
            {
                nextBadge = TrayBadgeState.Paused;
                trayTooltip = "T3Tools - 自动吸附已暂停";
            }
            else if (_cdpConnected)
            {
                nextBadge = TrayBadgeState.Attached;
                trayTooltip = string.Format("T3Tools - 已吸附到 T3 Code ({0} 窗口)", Math.Max(1, _cdpTargets));
            }
            else if (_t3UiRunning)
            {
                nextBadge = TrayBadgeState.NeedsRestart;
                trayTooltip = "T3Tools - T3 Code 未开调试端口（右键可重启吸附）";
            }
            else
            {
                nextBadge = TrayBadgeState.Waiting;
                trayTooltip = "T3Tools - 等待 T3 Code 启动";
            }

            this.Text = "T3Tools v" + _daemonVersion;

            if (_trayIcon != null)
            {
                _trayIcon.Text = trayTooltip.Length > 63 ? trayTooltip.Substring(0, 63) : trayTooltip;
                if (nextBadge != _currentBadge)
                {
                    _currentBadge = nextBadge;
                    Icon oldTray = _trayIcon.Icon;
                    Icon oldForm = this.Icon;
                    _trayIcon.Icon = TrayIconFactory.CreateStatusIcon(nextBadge, 32);
                    this.Icon = TrayIconFactory.CreateStatusIcon(nextBadge, 32);
                    if (oldTray != null) oldTray.Dispose();
                    if (oldForm != null) oldForm.Dispose();
                }
            }
        }

        private void ConfirmAndRelaunchT3()
        {
            var confirm = MessageBox.Show(
                "检测到 T3 Code 正在运行但未开启调试端口。\n\n将优雅关闭当前 T3 Code 主窗口并立即以吸附模式重新启动（不会丢失已保存会话），是否继续？",
                "重启 T3 Code 并吸附",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (confirm != DialogResult.Yes) return;
            PostDaemonActionAsync("/api/t3/relaunch", "{}", "正在重启 T3 Code 并等待自动吸附...");
        }

        private void PostDaemonActionAsync(string path, string jsonBody, string toastText)
        {
            PushToastToWebView(toastText);
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    if (!_ownsDaemon)
                    {
                        HandleExternalDaemonActionFallback(path);
                    }
                    else
                    {
                        HttpPostJson(_daemonUrl + path, jsonBody, 12000);
                    }
                }
                catch (Exception ex)
                {
                    PushToastToWebView("操作失败: " + ex.Message);
                }
                Thread.Sleep(500);
                PollStatusAsync();
                SafeInvoke(delegate { if (_webView != null && _webView.IsReady) _webView.PostJson("{\"type\":\"refresh\"}"); });
            });
        }

        private void HandleExternalDaemonActionFallback(string path)
        {
            string nodeExe;
            string cliPath = ResolveCliPath(out nodeExe);
            if (string.IsNullOrEmpty(cliPath)) return;
            string cmd = null;
            if (path == "/api/t3/launch") cmd = "launch";
            else if (path == "/api/t3/relaunch") cmd = "relaunch-t3";
            else if (path == "/api/launcher/patch-debug") cmd = "patch-debug";
            if (cmd == null) return;

            var psi = new ProcessStartInfo(nodeExe, string.Format("\"{0}\" {1}", cliPath, cmd));
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (var p = Process.Start(psi))
            {
                if (p == null || !p.WaitForExit(15000) || p.ExitCode != 0)
                    throw new InvalidOperationException("后台启动命令失败或超时");
            }
        }

        private void OpenDashboardInBrowser()
        {
            try { Process.Start(new ProcessStartInfo(_daemonUrl) { UseShellExecute = true }); }
            catch { }
        }

        private static bool ReadAutoStartEnabled()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(AutoStartRegPath, false))
                {
                    if (key == null) return false;
                    object val = key.GetValue(AutoStartValueName);
                    return val != null && !string.IsNullOrEmpty(val.ToString());
                }
            }
            catch { return false; }
        }

        private static bool WriteAutoStartEnabled(bool enabled)
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(AutoStartRegPath, true) ?? Registry.CurrentUser.CreateSubKey(AutoStartRegPath))
                {
                    if (key == null) return false;
                    if (enabled)
                    {
                        string exe = Application.ExecutablePath;
                        key.SetValue(AutoStartValueName, string.Format("\"{0}\" --tray", exe));
                    }
                    else
                    {
                        key.DeleteValue(AutoStartValueName, false);
                    }
                    return true;
                }
            }
            catch { return false; }
        }

        private void RestartApplication()
        {
            if (_exiting) return;
            Program.RestartRequested = true;
            Program.RestartStartInTray = !this.Visible;
            ExitApplication();
        }

        private void ExitApplication()
        {
            if (_exiting) return;
            _exiting = true;
            CleanupBeforeExit();
            Application.Exit();
        }

        private bool _cleanedUp;
        private void CleanupBeforeExit()
        {
            if (_cleanedUp) return;
            lock (_daemonStartLock) { _exiting = true; }
            _cleanedUp = true;

            try { SystemEvents.SessionEnding -= OnSessionEnding; } catch { }
            try { DismissActiveTrayMenu(); } catch { }
            try { if (_pollTimer != null) _pollTimer.Dispose(); } catch { }
            try { if (_idleMemTimer != null) _idleMemTimer.Dispose(); } catch { }
            try
            {
                _ipcStopEvent.Set();
                if (_ipcThread == null || _ipcThread.Join(1000)) _ipcStopEvent.Dispose();
            }
            catch { }

            try
            {
                if (_webView != null)
                {
                    _webView.Dispose();
                    _webView = null;
                }
            }
            catch { }

            if (_trayIcon != null)
            {
                try
                {
                    _trayIcon.Visible = false;
                    Icon trayImage = _trayIcon.Icon;
                    _trayIcon.Icon = null;
                    _trayIcon.Dispose();
                    if (trayImage != null) trayImage.Dispose();
                }
                catch { }
                _trayIcon = null;
            }

            Icon windowImage = this.Icon;
            this.Icon = null;
            if (windowImage != null) windowImage.Dispose();

            if (_daemonProcess != null)
            {
                try { if (_ownsDaemon && !_daemonProcess.HasExited && _daemonProcess.Id == _daemonPid) HttpPostJson(_daemonUrl + "/api/shutdown", "{}", 1500); }
                catch { }
                try
                {
                    if (_daemonProcess != null && !_daemonProcess.HasExited)
                    {
                        _daemonProcess.WaitForExit(2000);
                        if (!_daemonProcess.HasExited) _daemonProcess.Kill();
                    }
                }
                catch { }
            }

            try { if (_daemonProcess != null) _daemonProcess.Dispose(); } catch { }
            try { _childJob.Dispose(); } catch { }
        }

        private Dictionary<string, object> HttpGetJson(string url, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.AllowAutoRedirect = false;
            req.Method = "GET";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var stream = resp.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                return _json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
        }

        private Dictionary<string, object> HttpPostJson(string url, string jsonBody, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.AllowAutoRedirect = false;
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Headers["X-T3Tools-Token"] = _authToken;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            byte[] payload = Encoding.UTF8.GetBytes(jsonBody ?? "{}");
            req.ContentLength = payload.Length;
            using (var reqStream = req.GetRequestStream())
            {
                reqStream.Write(payload, 0, payload.Length);
            }
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var stream = resp.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                return _json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
        }

        private static Dictionary<string, object> GetDict(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.ContainsKey(key)) return null;
            return d[key] as Dictionary<string, object>;
        }

        private static string GetString(Dictionary<string, object> d, string key, string fallback)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
            return Convert.ToString(d[key]);
        }

        private static bool GetBool(Dictionary<string, object> d, string key, bool fallback)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
            try { return Convert.ToBoolean(d[key]); } catch { return fallback; }
        }

        private static int GetInt(Dictionary<string, object> d, string key, int fallback)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
            try { return Convert.ToInt32(d[key]); } catch { return fallback; }
        }
    }

    internal static class Program
    {
        private const string MutexName = @"Local\T3Tools_Tray_SingleInstance_v1";
        private const string WakeEventName = @"Local\T3Tools_Tray_Wakeup_v1";
        private const string QuitEventName = @"Local\T3Tools_Tray_Quit_v1";

        internal static bool RestartRequested;
        internal static bool RestartStartInTray;

        [STAThread]
        private static void Main(string[] args)
        {
            bool startInTray = false;
            bool requestQuit = false;
            bool waitRestart = false;
            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    string a = (args[i] ?? "").Trim().ToLowerInvariant();
                    if (a == "--tray" || a == "--minimized" || a == "/tray") startInTray = true;
                    if (a == "--quit" || a == "--stop" || a == "--exit") requestQuit = true;
                    if (a == "--wait-restart") waitRestart = true;
                }
            }

            bool createdNew;
            using (var mutex = new Mutex(true, MutexName, out createdNew))
            using (var wakeEvent = new EventWaitHandle(false, EventResetMode.AutoReset, WakeEventName))
            using (var quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName))
            {
                if (requestQuit)
                {
                    if (!createdNew) quitEvent.Set();
                    return;
                }

                if (!createdNew)
                {
                    if (waitRestart)
                    {
                        bool acquired = false;
                        try
                        {
                            acquired = mutex.WaitOne(4000);
                        }
                        catch (AbandonedMutexException)
                        {
                            acquired = true;
                        }
                        if (!acquired) return;
                    }
                    else
                    {
                        if (!startInTray) wakeEvent.Set();
                        return;
                    }
                }

                NativeMethods.EnableHighDpi();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new T3ToolsTrayForm(startInTray, wakeEvent, quitEvent));
            }

            if (RestartRequested)
            {
                try
                {
                    var psi = new ProcessStartInfo();
                    psi.FileName = Application.ExecutablePath;
                    psi.Arguments = RestartStartInTray ? "--tray --wait-restart" : "--wait-restart";
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                }
                catch { }
            }
        }
    }
}
