# Forge3D Bridge (Unity)

Editor package that opens a local server (`http://127.0.0.1:47824`) inside the Unity Editor so
Forge3D Studio and its MCP endpoint can:

- import a generated model (GLB through glTFast, installed on demand) and drop it in the scene;
- create cameras, lights, primitives and empty objects;
- list the scene hierarchy, move / rotate / scale / delete objects;
- capture the Scene or Game view;
- save the scene.

## Install

Package Manager → **+** → **Add package from git URL…**

```
https://github.com/Sutsikii/forge-3D.git?path=/unity/com.forge3d.bridge
```

or **Add package from disk…** and pick this folder's `package.json`.

The bridge starts with the editor. **Tools → Forge3D** restarts or stops it. Every change goes
through Undo. Requests carrying a browser `Origin` header are refused.
