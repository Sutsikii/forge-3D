using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace Forge3D.Bridge
{
    /// <summary>
    /// Local HTTP server inside the Unity Editor. Forge3D (and its MCP endpoint)
    /// talks to it to import generated models and inspect the open scene.
    /// Requests are received on a background thread and executed on the main
    /// thread, where the Unity API is allowed.
    /// </summary>
    [InitializeOnLoad]
    public static class ForgeBridge
    {
        public const int DefaultPort = 47824;
        const string PortPref = "Forge3D.Bridge.Port";
        const string EnabledPref = "Forge3D.Bridge.Enabled";
        const int MainThreadTimeoutMs = 180000;

        static HttpListener listener;
        static Thread thread;
        static readonly ConcurrentQueue<Action> mainQueue = new ConcurrentQueue<Action>();

        public static int Port
        {
            get => EditorPrefs.GetInt(PortPref, DefaultPort);
            set => EditorPrefs.SetInt(PortPref, value);
        }

        public static bool Enabled
        {
            get => EditorPrefs.GetBool(EnabledPref, true);
            set => EditorPrefs.SetBool(EnabledPref, value);
        }

        public static bool Running => listener != null && listener.IsListening;

        static ForgeBridge()
        {
            EditorApplication.update += Pump;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += Stop;
            if (Enabled) Start();
        }

        public static void Start()
        {
            if (Running) return;
            try
            {
                listener = new HttpListener();
                listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
                listener.Start();
                thread = new Thread(Loop) { IsBackground = true, Name = "Forge3D Bridge" };
                thread.Start();
                Debug.Log($"[Forge3D] Bridge listening on http://127.0.0.1:{Port}");
            }
            catch (Exception e)
            {
                listener = null;
                Debug.LogWarning($"[Forge3D] Bridge could not start on port {Port}: {e.Message}");
            }
        }

        public static void Stop()
        {
            try { listener?.Stop(); listener?.Close(); }
            catch (Exception) { /* already closed */ }
            listener = null;
        }

        static void Pump()
        {
            // Bounded so a burst of requests never freezes the editor frame.
            for (var n = 0; n < 8 && mainQueue.TryDequeue(out var action); n++) action();
        }

        static void Loop()
        {
            while (listener != null && listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = listener.GetContext(); }
                catch (Exception) { break; }
                ThreadPool.QueueUserWorkItem(_ => Serve(ctx));
            }
        }

        static void Serve(HttpListenerContext ctx)
        {
            int status = 200;
            object payload;
            try
            {
                // Browsers always send Origin; local tools do not. This keeps web
                // pages (DNS rebinding included) away from the editor.
                if (!string.IsNullOrEmpty(ctx.Request.Headers["Origin"]))
                    throw new BridgeError(403, "Origin not allowed");
                var command = ctx.Request.Url.AbsolutePath.Trim('/');
                string body;
                using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = reader.ReadToEnd();
                var args = MiniJson.Parse(body) as Dictionary<string, object> ?? new Dictionary<string, object>();
                payload = RunOnMainThread(() => BridgeCommands.Run(command, args));
            }
            catch (BridgeError e)
            {
                status = e.Status;
                payload = new Dictionary<string, object> { ["ok"] = false, ["error"] = e.Message };
            }
            catch (Exception e)
            {
                status = 500;
                payload = new Dictionary<string, object> { ["ok"] = false, ["error"] = $"{e.GetType().Name}: {e.Message}" };
            }

            try
            {
                var bytes = Encoding.UTF8.GetBytes(MiniJson.Write(payload));
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = "application/json; charset=utf-8";
                ctx.Response.ContentLength64 = bytes.Length;
                ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
                ctx.Response.OutputStream.Close();
            }
            catch (Exception) { /* client went away */ }
        }

        static object RunOnMainThread(Func<object> fn)
        {
            object result = null;
            Exception error = null;
            using (var done = new ManualResetEventSlim(false))
            {
                mainQueue.Enqueue(() =>
                {
                    try { result = fn(); }
                    catch (Exception e) { error = e; }
                    finally { done.Set(); }
                });
                if (!done.Wait(MainThreadTimeoutMs))
                    throw new BridgeError(504, "Unity main thread did not answer in time (modal dialog open?)");
            }
            if (error != null)
            {
                if (error is BridgeError) throw error;
                throw new Exception(error.Message, error);
            }
            return result;
        }

        [MenuItem("Tools/Forge3D/Restart Bridge")]
        static void MenuRestart()
        {
            Enabled = true;
            Stop();
            Start();
        }

        [MenuItem("Tools/Forge3D/Stop Bridge")]
        static void MenuStop()
        {
            Enabled = false;
            Stop();
            Debug.Log("[Forge3D] Bridge stopped");
        }
    }

    public sealed class BridgeError : Exception
    {
        public readonly int Status;
        public BridgeError(int status, string message) : base(message) { Status = status; }
    }
}
