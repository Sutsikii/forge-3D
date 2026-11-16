using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace Forge3D.Bridge
{
    /// <summary>Commands exposed by the bridge. Always called on the main thread.</summary>
    public static class BridgeCommands
    {
        const string GltfPackage = "com.unity.cloud.gltfast";
        static AddRequest gltfRequest;

        public static object Run(string command, Dictionary<string, object> a)
        {
            switch (command)
            {
                case "status": return Status();
                case "scene": return Scene(a);
                case "import": return Import(a);
                case "create": return Create(a);
                case "transform": return Transform(a);
                case "delete": return Delete(a);
                case "screenshot": return Screenshot(a);
                case "save_scene": return SaveScene();
                case "install_gltf": return InstallGltf();
                default: throw new BridgeError(404, $"Unknown command '{command}'");
            }
        }

        // ------------------------------------------------------------ status
        static bool HasGltf()
        {
            return UnityEditor.PackageManager.PackageInfo.GetAllRegisteredPackages()
                .Any(p => p.name == GltfPackage);
        }

        static object Status()
        {
            var scene = SceneManager.GetActiveScene();
            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["unity"] = Application.unityVersion,
                ["product"] = Application.productName,
                ["project"] = Path.GetDirectoryName(Application.dataPath),
                ["scene"] = scene.path,
                ["scene_name"] = scene.name,
                ["scene_dirty"] = scene.isDirty,
                ["playing"] = EditorApplication.isPlaying,
                ["compiling"] = EditorApplication.isCompiling,
                ["gltf"] = HasGltf(),
                ["gltf_installing"] = gltfRequest != null && !gltfRequest.IsCompleted,
                ["render_pipeline"] = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline != null
                    ? UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline.GetType().Name
                    : "Built-in",
            };
        }

        static object InstallGltf()
        {
            if (HasGltf()) return new Dictionary<string, object> { ["ok"] = true, ["installed"] = true };
            if (gltfRequest == null || gltfRequest.IsCompleted)
                gltfRequest = Client.Add(GltfPackage);
            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["installed"] = false,
                ["message"] = "glTFast is being installed; Unity will recompile, then retry.",
            };
        }

        // ------------------------------------------------------------- scene
        static object Scene(Dictionary<string, object> a)
        {
            var depth = (int)Num(a, "max_depth", 2);
            var scene = SceneManager.GetActiveScene();
            var roots = scene.GetRootGameObjects().Select(go => Describe(go, depth)).ToList();
            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["scene"] = scene.path,
                ["objects"] = roots,
                ["selection"] = Selection.gameObjects.Select(PathOf).ToList(),
            };
        }

        static Dictionary<string, object> Describe(GameObject go, int depth)
        {
            var t = go.transform;
            var d = new Dictionary<string, object>
            {
                ["name"] = go.name,
                ["path"] = PathOf(go),
                ["active"] = go.activeSelf,
                ["position"] = Vec(t.position),
                ["rotation"] = Vec(t.eulerAngles),
                ["scale"] = Vec(t.localScale),
                ["components"] = go.GetComponents<Component>().Where(c => c != null && !(c is UnityEngine.Transform))
                    .Select(c => c.GetType().Name).ToList(),
            };
            if (t.childCount > 0)
            {
                if (depth > 0)
                    d["children"] = Enumerable.Range(0, t.childCount)
                        .Select(i => (object)Describe(t.GetChild(i).gameObject, depth - 1)).ToList();
                else
                    d["child_count"] = t.childCount;
            }
            return d;
        }

        // ------------------------------------------------------------ import
        static object Import(Dictionary<string, object> a)
        {
            var source = Str(a, "source");
            if (string.IsNullOrEmpty(source) || !File.Exists(source))
                throw new BridgeError(400, $"Source file not found: {source}");
            var ext = Path.GetExtension(source).ToLowerInvariant();
            if ((ext == ".glb" || ext == ".gltf") && !HasGltf())
            {
                InstallGltf();
                throw new BridgeError(409, "glTFast is required to import GLB; installation started, retry in a moment.");
            }

            var folder = (Str(a, "folder") ?? "Assets/Forge3D").Replace('\\', '/').TrimEnd('/');
            if (folder != "Assets" && !folder.StartsWith("Assets/"))
                throw new BridgeError(400, "folder must be inside Assets/");
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            Directory.CreateDirectory(Path.Combine(projectRoot, folder));

            var name = Sanitize(Str(a, "name") ?? Path.GetFileNameWithoutExtension(source));
            var assetPath = AssetDatabase.GenerateUniqueAssetPath($"{folder}/{name}{ext}");
            File.Copy(source, Path.Combine(projectRoot, assetPath));
            // Side files (OBJ materials and textures) go next to the model.
            if (a.TryGetValue("extra_files", out var extra) && extra is List<object> files)
            {
                foreach (var f in files.OfType<string>().Where(File.Exists))
                {
                    var dest = Path.Combine(projectRoot, folder, Path.GetFileName(f));
                    if (!File.Exists(dest)) File.Copy(f, dest);
                }
            }
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);

            var result = new Dictionary<string, object> { ["ok"] = true, ["asset"] = assetPath };
            var model = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (model == null)
                throw new BridgeError(500, $"Unity imported {assetPath} but produced no model (importer missing?)");

            if (Bool(a, "place", true))
            {
                var go = (GameObject)PrefabUtility.InstantiatePrefab(model);
                go.name = name;
                Undo.RegisterCreatedObjectUndo(go, "Forge3D import");
                var parentPath = Str(a, "parent");
                if (!string.IsNullOrEmpty(parentPath))
                    go.transform.SetParent(Find(parentPath).transform, false);
                ApplyTransform(go.transform, a);
                // Generated meshes are centred on their origin: rest the base on the target point.
                var placed = BoundsOf(go);
                if (Bool(a, "on_ground", true) && placed.HasValue)
                    go.transform.position += Vector3.up * (go.transform.position.y - placed.Value.min.y);
                Selection.activeGameObject = go;
                EditorSceneManager.MarkSceneDirty(go.scene);
                var bounds = BoundsOf(go);
                if (Bool(a, "frame", true) && SceneView.lastActiveSceneView != null && bounds.HasValue)
                    SceneView.lastActiveSceneView.Frame(bounds.Value, false);
                result["instance"] = PathOf(go);
                if (bounds.HasValue)
                    result["bounds"] = new Dictionary<string, object>
                    {
                        ["center"] = Vec(bounds.Value.center),
                        ["size"] = Vec(bounds.Value.size),
                    };
            }
            return result;
        }

        // ------------------------------------------------------------ create
        static object Create(Dictionary<string, object> a)
        {
            var type = (Str(a, "type") ?? "empty").ToLowerInvariant();
            GameObject go;
            switch (type)
            {
                case "empty": go = new GameObject(); break;
                case "camera": go = new GameObject("Camera", typeof(Camera)); break;
                case "light":
                    go = new GameObject("Directional Light");
                    var light = go.AddComponent<Light>();
                    light.type = LightType.Directional;
                    break;
                case "point_light":
                    go = new GameObject("Point Light");
                    go.AddComponent<Light>().type = LightType.Point;
                    break;
                case "cube": go = GameObject.CreatePrimitive(PrimitiveType.Cube); break;
                case "sphere": go = GameObject.CreatePrimitive(PrimitiveType.Sphere); break;
                case "plane": go = GameObject.CreatePrimitive(PrimitiveType.Plane); break;
                case "cylinder": go = GameObject.CreatePrimitive(PrimitiveType.Cylinder); break;
                case "capsule": go = GameObject.CreatePrimitive(PrimitiveType.Capsule); break;
                case "quad": go = GameObject.CreatePrimitive(PrimitiveType.Quad); break;
                default:
                    throw new BridgeError(400, "type must be empty, camera, light, point_light, cube, sphere, plane, cylinder, capsule or quad");
            }
            var name = Str(a, "name");
            if (!string.IsNullOrEmpty(name)) go.name = name;
            else if (type == "empty") go.name = "GameObject";
            Undo.RegisterCreatedObjectUndo(go, "Forge3D create");
            var parentPath = Str(a, "parent");
            if (!string.IsNullOrEmpty(parentPath)) go.transform.SetParent(Find(parentPath).transform, false);
            ApplyTransform(go.transform, a);
            if (TryVec(a, "look_at", out var target))
                go.transform.LookAt(target);
            EditorSceneManager.MarkSceneDirty(go.scene);
            return new Dictionary<string, object> { ["ok"] = true, ["object"] = Describe(go, 0) };
        }

        // --------------------------------------------------------- transform
        static object Transform(Dictionary<string, object> a)
        {
            var go = Find(Str(a, "path"));
            Undo.RecordObject(go.transform, "Forge3D transform");
            ApplyTransform(go.transform, a);
            EditorSceneManager.MarkSceneDirty(go.scene);
            return new Dictionary<string, object> { ["ok"] = true, ["object"] = Describe(go, 0) };
        }

        static object Delete(Dictionary<string, object> a)
        {
            var go = Find(Str(a, "path"));
            var scene = go.scene;
            Undo.DestroyObjectImmediate(go);
            EditorSceneManager.MarkSceneDirty(scene);
            return new Dictionary<string, object> { ["ok"] = true };
        }

        static void ApplyTransform(UnityEngine.Transform t, Dictionary<string, object> a)
        {
            if (TryVec(a, "position", out var p)) t.localPosition = p;
            if (TryVec(a, "rotation", out var r)) t.localEulerAngles = r;
            if (a.TryGetValue("scale", out var s) && s != null)
                t.localScale = s is double d ? Vector3.one * (float)d : TryVec(a, "scale", out var v) ? v : t.localScale;
        }

        // -------------------------------------------------------- screenshot
        static object Screenshot(Dictionary<string, object> a)
        {
            var w = Mathf.Clamp((int)Num(a, "width", 960), 64, 2048);
            var h = Mathf.Clamp((int)Num(a, "height", 540), 64, 2048);
            Camera cam;
            if (Str(a, "view") == "game")
            {
                cam = Camera.main ?? Object.FindObjectsByType<Camera>(FindObjectsSortMode.None).FirstOrDefault();
                if (cam == null) throw new BridgeError(409, "No camera in the scene");
            }
            else
            {
                var sv = SceneView.lastActiveSceneView;
                if (sv == null) throw new BridgeError(409, "No Scene view open");
                var focus = Str(a, "focus");
                if (!string.IsNullOrEmpty(focus))
                {
                    var b = BoundsOf(Find(focus));
                    if (b.HasValue) sv.Frame(b.Value, true);
                }
                sv.Repaint();
                cam = sv.camera;
            }

            var rt = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGB32);
            var prevTarget = cam.targetTexture;
            var prevAspect = cam.aspect;
            var prevActive = RenderTexture.active;
            var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
            try
            {
                cam.targetTexture = rt;
                cam.aspect = (float)w / h;
                cam.Render();
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                tex.Apply();
                return new Dictionary<string, object>
                {
                    ["ok"] = true,
                    ["png_base64"] = Convert.ToBase64String(tex.EncodeToPNG()),
                    ["width"] = w,
                    ["height"] = h,
                };
            }
            finally
            {
                cam.targetTexture = prevTarget;
                cam.aspect = prevAspect;
                RenderTexture.active = prevActive;
                RenderTexture.ReleaseTemporary(rt);
                Object.DestroyImmediate(tex);
            }
        }

        static object SaveScene()
        {
            var scene = SceneManager.GetActiveScene();
            if (string.IsNullOrEmpty(scene.path))
                throw new BridgeError(409, "The scene has never been saved; save it once from Unity first");
            var ok = EditorSceneManager.SaveScene(scene);
            return new Dictionary<string, object> { ["ok"] = ok, ["scene"] = scene.path };
        }

        // ----------------------------------------------------------- helpers
        static string PathOf(GameObject go)
        {
            var parts = new List<string>();
            for (var t = go.transform; t != null; t = t.parent) parts.Insert(0, t.name);
            return string.Join("/", parts);
        }

        static GameObject Find(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new BridgeError(400, "path is required");
            var parts = path.Trim('/').Split('/');
            var scene = SceneManager.GetActiveScene();
            var current = scene.GetRootGameObjects().FirstOrDefault(g => g.name == parts[0]);
            for (var i = 1; current != null && i < parts.Length; i++)
            {
                var child = current.transform.Cast<UnityEngine.Transform>().FirstOrDefault(c => c.name == parts[i]);
                current = child != null ? child.gameObject : null;
            }
            if (current == null) throw new BridgeError(404, $"No object at '{path}'");
            return current;
        }

        static Bounds? BoundsOf(GameObject go)
        {
            var renderers = go.GetComponentsInChildren<Renderer>();
            if (renderers.Length == 0) return null;
            var b = renderers[0].bounds;
            foreach (var r in renderers.Skip(1)) b.Encapsulate(r.bounds);
            return b;
        }

        static string Sanitize(string name)
        {
            var invalid = Path.GetInvalidFileNameChars();
            var clean = new string(name.Select(c => invalid.Contains(c) || c == '/' ? '_' : c).ToArray()).Trim();
            return string.IsNullOrEmpty(clean) ? "Forge3D Model" : clean;
        }

        static List<object> Vec(Vector3 v) => new List<object> { v.x, v.y, v.z };

        static bool TryVec(Dictionary<string, object> a, string key, out Vector3 v)
        {
            v = default;
            if (!a.TryGetValue(key, out var o) || !(o is List<object> l) || l.Count != 3) return false;
            v = new Vector3(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]));
            return true;
        }

        static string Str(Dictionary<string, object> a, string key) =>
            a.TryGetValue(key, out var o) && o != null ? o.ToString() : null;

        static double Num(Dictionary<string, object> a, string key, double fallback) =>
            a.TryGetValue(key, out var o) && o is double d ? d : fallback;

        static bool Bool(Dictionary<string, object> a, string key, bool fallback) =>
            a.TryGetValue(key, out var o) && o is bool b ? b : fallback;
    }
}
